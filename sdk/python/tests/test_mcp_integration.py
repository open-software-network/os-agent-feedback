from __future__ import annotations

import asyncio
import importlib.util
import json
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_feedback import AgentFeedback, AgentFeedbackOptions

if importlib.util.find_spec("mcp") is None:  # dependency-free suite
    raise unittest.SkipTest("optional MCP dependency is not installed")

try:
    from agent_feedback.mcp import MCPInstrumentation, MCPProductContext
    from mcp import Client, MCPError
    from mcp.server import MCPServer
    from mcp_types import CallToolResult, InputRequiredResult, TextContent
except ImportError:
    raise

KEY = "af_live_0123456789abcdef0123456789abcdef_" + "x" * 32


class MCPIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.bodies: list[bytes] = []
        self.resolver_calls = 0

        def sender(_url: str, _headers: dict[str, str], body: bytes) -> None:
            self.bodies.append(body)

        self.feedback = AgentFeedback(AgentFeedbackOptions(
            api_key=KEY, flush_interval=3600, sender=sender
        ))

    async def asyncTearDown(self) -> None:
        self.feedback.shutdown()

    def events(self) -> list[dict]:
        self.assertTrue(self.feedback.flush())
        return [event for body in self.bodies for event in json.loads(body)["events"]]

    def make_server(self, resolver=None):
        instrumentation = MCPInstrumentation(self.feedback, resolver)
        return MCPServer("integration", extensions=[instrumentation]), instrumentation

    async def test_public_client_completion_matrix(self) -> None:
        trusted_account = "account-a"
        registry = {"session-a": trusted_account, "session-b": trusted_account}

        def resolve(params, _ctx, result):
            self.resolver_calls += 1
            args = params.arguments or {}
            structured = result if isinstance(result, dict) else (
                getattr(result, "structured_content", None) or {}
            )
            session = structured.get("session") or args.get("session")
            if registry.get(session) != trusted_account:
                return MCPProductContext()
            return MCPProductContext(account_ref=trusted_account, session_ref=session)

        server, mark = self.make_server(resolve)
        sync_threads: list[str] = []

        @server.tool()
        @mark.instrument_tool
        def create(session: str, marker: str) -> dict:
            sync_threads.append(threading.current_thread().name)
            return {"session": "session-a", "marker": marker}

        @server.tool()
        @mark.instrument_tool
        async def follow(session: str, marker: str) -> dict:
            await asyncio.sleep(0)
            return {"session": session, "marker": marker}

        @server.tool()
        @mark.instrument_tool
        def explicit(marker: str):
            return CallToolResult(content=[TextContent(type="text", text=marker)], isError=True)

        @server.tool()
        @mark.instrument_tool
        def ordinary(marker: str):
            raise RuntimeError(marker)

        @server.tool()
        @mark.instrument_tool
        def mcp_error(marker: str):
            raise MCPError(-32000, marker)

        @server.tool()
        @mark.instrument_tool
        def input_needed():
            return InputRequiredResult(requestState="continue-token")

        @server.tool()
        @mark.instrument_tool
        def cannot_convert():
            class Unprintable:
                def __str__(self):
                    raise ValueError("conversion failed")

                def __repr__(self):
                    raise ValueError("conversion failed")

            return Unprintable()

        @server.tool()
        def undecorated():
            return "no event"

        async with Client(server, mode="legacy", raise_exceptions=True,
                          input_required_max_rounds=0) as client:
            names = {tool.name for tool in (await client.list_tools()).tools}
            self.assertIn("create", names)
            first = await client.call_tool("create", {
                "session": "evil", "marker": "ARG_SECRET"
            })
            second = await client.call_tool("follow", {
                "session": "session-a", "marker": "RESULT_SECRET"
            })
            self.assertFalse(first.is_error)
            self.assertFalse(second.is_error)
            self.assertTrue(sync_threads)
            self.assertTrue((await client.call_tool("explicit", {"marker": "EXPLICIT_SECRET"})).is_error)
            self.assertTrue((await client.call_tool("ordinary", {"marker": "ERROR_SECRET"})).is_error)
            with self.assertRaisesRegex(MCPError, "MCP_ERROR_SECRET"):
                await client.call_tool("mcp_error", {"marker": "MCP_ERROR_SECRET"})
            # Public legacy transport handles all three framework failures as wire errors.
            self.assertTrue((await client.call_tool("missing", {})).is_error)
            self.assertTrue((await client.call_tool("create", {})).is_error)
            self.assertTrue((await client.call_tool("cannot_convert", {})).is_error)
            # The extension passes input-required through without recording it;
            # legacy wire validation currently reports that public result as an error.
            with self.assertRaisesRegex(MCPError, "invalid result"):
                await client.call_tool("input_needed", {})
            await client.call_tool("undecorated", {})

        events = self.events()
        self.assertEqual([event["statusCode"] for event in events], [200, 200, 500, 500, 500])
        self.assertEqual(events[0]["sessionRef"], "session-a")  # canonical result wins
        self.assertEqual(events[1]["sessionRef"], "session-a")  # validated follow-up
        self.assertEqual(events[0]["accountRef"], events[1]["accountRef"])
        self.assertTrue(all(event.get("durationMs", -1) >= 0 for event in events))
        wire = b"".join(self.bodies)
        for secret in (b"ARG_SECRET", b"RESULT_SECRET", b"EXPLICIT_SECRET",
                       b"ERROR_SECRET", b"MCP_ERROR_SECRET"):
            self.assertNotIn(secret, wire)

    async def test_identity_fail_closed_concurrency_disable_and_shutdown(self) -> None:
        mode = "ok"
        trusted_account = "account-a"
        registry = {"session-a": trusted_account, "session-b": trusted_account}

        def resolver(_params, _ctx, result):
            self.resolver_calls += 1
            if mode == "raise":
                raise RuntimeError("RESOLVER_SECRET")
            if mode == "wrong":
                return {"account_ref": "leak"}
            session = result.get("session") if isinstance(result, dict) else None
            if registry.get(session) != trusted_account:
                return MCPProductContext()
            return MCPProductContext(account_ref=trusted_account, session_ref=session)

        server, mark = self.make_server(resolver)

        @server.tool()
        @mark.instrument_tool
        def concurrent(marker: str):
            if marker == "a":
                threading.Event().wait(0.01)
            return {"marker": marker, "session": f"session-{marker}"}

        async with Client(server, mode="legacy", raise_exceptions=True) as client:
            await asyncio.gather(*(
                client.call_tool("concurrent", {"marker": value})
                for value in ("a", "b")
            ))
            await client.call_tool("concurrent", {"marker": "wrong-proof"})
            await client.call_tool("concurrent", {"marker": "missing-proof"})
            mode = "raise"
            await client.call_tool("concurrent", {"marker": "resolver-error"})
            mode = "wrong"
            await client.call_tool("concurrent", {"marker": "wrong-type"})

            events = self.events()
            linked = {(event.get("accountRef"), event.get("sessionRef")) for event in events[:2]}
            self.assertEqual(linked, {("account-a", "session-a"), ("account-a", "session-b")})
            for event in events[2:]:
                self.assertNotIn("accountRef", event)
                self.assertNotIn("sessionRef", event)
            self.assertNotIn(b"RESOLVER_SECRET", b"".join(self.bodies))

            before = self.resolver_calls
            self.assertTrue(self.feedback.shutdown())
            await client.call_tool("concurrent", {"marker": "shutdown"})
            self.assertEqual(self.resolver_calls, before)

        disabled = AgentFeedback(AgentFeedbackOptions(api_key=KEY, feedback_mode="off"))
        disabled_mark = MCPInstrumentation(disabled, resolver)
        disabled_server = MCPServer("disabled", extensions=[disabled_mark])

        @disabled_server.tool()
        @disabled_mark.instrument_tool
        def disabled_tool():
            return "ok"

        async with Client(disabled_server, mode="legacy") as client:
            await client.call_tool("disabled_tool", {})
        self.assertEqual(self.resolver_calls, before)
        disabled.shutdown()

    async def test_interceptor_preserves_identity_and_exact_handler_error(self) -> None:
        """Properties serialization cannot expose are proved at the public hook boundary."""
        _server, mark = self.make_server()
        params = SimpleNamespace(name="identity", arguments={})
        result = CallToolResult(content=[TextContent(type="text", text="same")])

        @mark.instrument_tool
        async def identity_handler():
            return result

        async def exact(_ctx):
            return await identity_handler()

        self.assertIs(await mark.intercept_tool_call(params, None, exact), result)

        input_required = InputRequiredResult(requestState="continue-token")
        async def input_next(_ctx):
            return input_required
        self.assertIs(await mark.intercept_tool_call(params, None, input_next), input_required)

        error = MCPError(-32000, "exact")

        @mark.instrument_tool
        async def error_handler():
            raise error

        async def raises(_ctx):
            return await error_handler()

        with self.assertRaises(MCPError) as caught:
            await mark.intercept_tool_call(SimpleNamespace(name="mcp_error", arguments={}), None, raises)
        self.assertIs(caught.exception, error)
        self.assertEqual([event["statusCode"] for event in self.events()], [200, 500])

    async def test_recording_failure_is_fail_open(self) -> None:
        _server, mark = self.make_server()
        result = object()
        error = RuntimeError("product")
        mark._record = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("adapter"))

        @mark.instrument_tool
        def returns():
            return result
        async def return_next(_ctx):
            returns()
            return result
        self.assertIs(await mark.intercept_tool_call(SimpleNamespace(name="return", arguments={}), None, return_next), result)

        @mark.instrument_tool
        def raises():
            raise error
        async def raise_next(_ctx):
            return raises()
        with self.assertRaises(RuntimeError) as caught:
            await mark.intercept_tool_call(SimpleNamespace(name="raise", arguments={}), None, raise_next)
        self.assertIs(caught.exception, error)

    async def test_completion_clock_excludes_resolver_delay(self) -> None:
        def slow_resolver(_params, _ctx, _result):
            threading.Event().wait(0.15)
            return MCPProductContext()
        _server, mark = self.make_server(slow_resolver)
        @mark.instrument_tool
        def quick():
            return "ok"
        async def next_call(_ctx):
            quick()
            return CallToolResult(content=[TextContent(type="text", text="ok")])
        before = datetime.now(timezone.utc)
        await mark.intercept_tool_call(SimpleNamespace(name="quick", arguments={}), None, next_call)
        after = datetime.now(timezone.utc)
        event = self.events()[0]
        occurred = datetime.fromisoformat(event["occurredAt"].replace("Z", "+00:00"))
        self.assertLess(event["durationMs"], 100)
        self.assertGreater((after - occurred).total_seconds(), 0.10)
        self.assertGreaterEqual(occurred.timestamp(), before.timestamp() - 0.001)

    async def test_example_create_and_revise_public_client(self) -> None:
        example_path = Path(__file__).parents[3] / "examples/python-mcp/server.py"
        spec = importlib.util.spec_from_file_location("python_mcp_example", example_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        bodies: list[bytes] = []
        with patch.dict("os.environ", {
            "AGENT_FEEDBACK_API_KEY": KEY,
            "DEMO_ACCOUNT_REF": "trusted-example-account",
        }):
            spec.loader.exec_module(module)
        module.feedback.telemetry.options.sender = (
            lambda _url, _headers, body: bodies.append(body)
        )
        module.feedback.telemetry.options.flush_interval = 3600
        module.feedback.telemetry.options.shutdown_timeout = 1
        try:
            async with Client(module.server, mode="legacy") as client:
                created = await client.call_tool("create_summary", {"text": "first"})
                self.assertFalse(created.is_error)
                session = created.structured_content["session_ref"]
                revised = await client.call_tool(
                    "revise_summary", {"session_ref": session, "text": "second"}
                )
                self.assertFalse(revised.is_error)
            self.assertTrue(module.feedback.flush())
            events = [event for body in bodies for event in json.loads(body)["events"]]
            self.assertEqual(len(events), 2)
            self.assertEqual({event["sessionRef"] for event in events}, {session})
            self.assertEqual(
                {event["accountRef"] for event in events}, {"trusted-example-account"}
            )
        finally:
            module.feedback.shutdown()


if __name__ == "__main__":
    unittest.main()
