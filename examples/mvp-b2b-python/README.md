# B2B SaaS — language-neutral company integration

This dependency-free WSGI example documents the same contract a Python, Java, .NET, PHP, Ruby, or other backend can implement:

- verified account and user references come from product authentication;
- context requests and reads use the server-only `EPODE_API_KEY`;
- the agent answers only through the company's same-origin relay;
- onboarding modules are personalized and activation is measured.

The relay rejects regulated or credential-bearing context before any network
call. The manual HTTP client never follows redirects, caps Epode responses at
1 MiB, and rewrites every returned consent or submit action to the company&apos;s
same-origin relay paths.

```bash
EPODE_API_KEY=af_live_... python3 app.py
```
