"use client";

import { IconEditSmall2 } from "central-icons/IconEditSmall2";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageHeader, Panel, StatusMessage } from "@/components/dashboard/view-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type ContextFieldDefinition,
  type ContextFieldInput,
  type DefaultCatalogEntry,
  deleteContextField,
  listContextFields,
  saveContextField,
} from "@/lib/api/context-fields";
import type { DashboardData } from "@/lib/api/dashboard";
import {
  contextKeyForCategory,
  summarizeExperienceActivity,
} from "@/lib/dashboard/experience-activity";
import { isEditor, relativeDate, titleCase } from "@/lib/dashboard/format";

type FieldFormState = {
  key: string;
  label: string;
  type: string;
  allowedValues: string;
  operations: string;
  enabled: boolean;
};

const emptyForm: FieldFormState = {
  key: "",
  label: "",
  type: "preference",
  allowedValues: "",
  operations: "",
  enabled: true,
};

function formFor(field: ContextFieldDefinition): FieldFormState {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    allowedValues: field.allowedValues.join(", "),
    operations: (field.operations ?? []).join(", "),
    enabled: field.enabled,
  };
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateForm(form: FieldFormState, creating: boolean): string {
  if (creating && !/^[a-z][a-z0-9_]{0,30}\.[a-z][a-z0-9_]{0,46}$/.test(form.key.trim())) {
    return "Field key must be a lowercase namespace.name pair such as journey.occasion.";
  }
  if (creating && form.key.trim().startsWith("epode.")) {
    return "The epode.* namespace is reserved for built-in fields.";
  }
  if (form.label.trim().length < 3 || form.label.trim().length > 120) {
    return "Question must be between 3 and 120 characters.";
  }
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(form.type.trim())) {
    return "Type must be a lowercase snake_case name between 1 and 48 characters.";
  }
  const values = parseList(form.allowedValues);
  if (values.length === 0 || values.length > 32) {
    return "Allowed values must contain 1 to 32 entries.";
  }
  const badValue = values.some((value) => !/^[a-z][a-z0-9_]{0,47}$/.test(value));
  if (badValue || new Set(values).size !== values.length) {
    return "Allowed values must be distinct lowercase snake_case entries.";
  }
  if (parseList(form.operations).length > 32) {
    return "Operations must contain at most 32 entries.";
  }
  return "";
}

export function QuestionsView({
  data,
  setNotice,
}: {
  data: DashboardData;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const product = data.currentProduct;
  const editor = isEditor(data.currentRole);
  const [fields, setFields] = useState<ContextFieldDefinition[] | null>(null);
  const [legacyCatalogActive, setLegacyCatalogActive] = useState(false);
  const [defaultCatalog, setDefaultCatalog] = useState<DefaultCatalogEntry[]>([]);
  const [error, setError] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<ContextFieldDefinition | null>(null);
  const [form, setForm] = useState<FieldFormState>(emptyForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!product) return;
    try {
      const result = await listContextFields(product.id, data.workspace.id);
      setFields(result.fields);
      setLegacyCatalogActive(result.legacyCatalogActive);
      setDefaultCatalog(result.defaultCatalog);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Questions could not be loaded.");
    }
  }, [product, data.workspace.id]);

  useEffect(() => {
    setFields(null);
    void load();
  }, [load]);

  if (!product) {
    return <Panel>No product is selected.</Panel>;
  }

  function openCreate(prefill?: Partial<FieldFormState>) {
    setEditing(null);
    setForm({ ...emptyForm, ...prefill });
    setFormError("");
    setSheetOpen(true);
  }

  function openEdit(field: ContextFieldDefinition) {
    setEditing(field);
    setForm(formFor(field));
    setFormError("");
    setSheetOpen(true);
  }

  async function submit() {
    if (!product) return;
    const validation = validateForm(form, editing === null);
    if (validation) {
      setFormError(validation);
      return;
    }
    const operations = parseList(form.operations);
    const input: ContextFieldInput = {
      label: form.label.trim(),
      type: form.type.trim(),
      allowedValues: parseList(form.allowedValues),
      targetedAdvertisingSafe: editing?.targetedAdvertisingSafe ?? false,
      operations: operations.length ? operations : null,
      enabled: form.enabled,
    };
    setSaving(true);
    setFormError("");
    try {
      await saveContextField(product.id, form.key.trim(), input, data.workspace.id);
      setSheetOpen(false);
      setNotice(`Saved question ${form.key.trim()}.`);
      await load();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The question could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(key: string) {
    if (!product) return;
    try {
      await deleteContextField(product.id, key, data.workspace.id);
      setPendingDelete(null);
      setNotice(`Deleted question ${key}.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The question could not be deleted.");
      setPendingDelete(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <PageHeader
        eyebrow="Agent experience"
        title="Context"
        description="What journeys teach this product. The experience graph elicits needs per task; remembered context is what you deliberately keep across journeys."
        actions={
          editor ? (
            <Button type="button" onClick={() => openCreate()}>
              <IconPlusSmall />
              Add question
            </Button>
          ) : undefined
        }
      />
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      <JourneyDimensions
        data={data}
        editor={editor}
        rememberedKeys={new Set((fields ?? []).map((field) => field.key))}
        onRemember={(category) => {
          const needsKey = contextKeyForCategory(category);
          openCreate({
            key: needsKey,
            label: `${titleCase(category)} journey need`,
            type: "preference",
            allowedValues: "",
            operations: `/agent-negotiate/${category}, /agent-decide/${category}`,
            enabled: true,
          });
        }}
      />
      {legacyCatalogActive ? (
        <Panel title="Default questions in use">
          <p className="text-sm text-muted-foreground">
            This product currently asks the built-in questions listed below. Add a question of your
            own to start a custom catalog — as soon as one of your questions is enabled, your
            catalog replaces the default set for every new request.
          </p>
        </Panel>
      ) : null}
      {fields === null ? (
        <Panel>Loading questions…</Panel>
      ) : fields.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted-foreground">
            No questions defined yet. Each question needs a key, a customer-facing prompt, a type,
            and a closed list of allowed values.
          </p>
        </Panel>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Question</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Allowed values</TableHead>
                <TableHead>Operations</TableHead>
                <TableHead>State</TableHead>
                {editor ? <TableHead className="w-28" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field) => (
                <TableRow key={field.key}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm">{field.label}</span>
                      <code className="text-xs text-muted-foreground">{field.key}</code>
                    </div>
                  </TableCell>
                  <TableCell>{field.type}</TableCell>
                  <TableCell>
                    <div className="flex max-w-64 flex-wrap gap-1">
                      {field.allowedValues.slice(0, 4).map((value) => (
                        <Badge key={value} variant="secondary">
                          {value}
                        </Badge>
                      ))}
                      {field.allowedValues.length > 4 ? (
                        <Badge variant="outline">+{field.allowedValues.length - 4}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {field.operations ? (
                      <div className="flex max-w-48 flex-wrap gap-1">
                        {field.operations.map((operation) => (
                          <Badge key={operation} variant="outline">
                            {operation}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">All operations</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {field.enabled ? (
                      <Badge>Enabled</Badge>
                    ) : (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                  </TableCell>
                  {editor ? (
                    <TableCell>
                      {pendingDelete === field.key ? (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => void confirmDelete(field.key)}
                          >
                            Confirm
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setPendingDelete(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit ${field.key}`}
                            onClick={() => openEdit(field)}
                          >
                            <IconEditSmall2 />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete ${field.key}`}
                            onClick={() => setPendingDelete(field.key)}
                          >
                            <IconTrashCanSimple />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
      {!editor ? (
        <p className="text-sm text-muted-foreground">
          Only a team owner or admin can change questions.
        </p>
      ) : null}
      {legacyCatalogActive && defaultCatalog.length > 0 ? (
        <Panel title="Default questions (built in)">
          <p className="mb-3 text-sm text-muted-foreground">
            Shared defaults for products that have not defined their own questions. They cannot be
            edited; enabling any question of your own replaces this entire set.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Question key</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Allowed values</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {defaultCatalog.map((field) => (
                <TableRow key={field.key}>
                  <TableCell>
                    <div className="flex flex-col">
                      <code className="text-sm">{field.key}</code>
                      <span className="text-xs text-muted-foreground">
                        {field.key.replace(/[._]/g, " ")}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{field.type}</TableCell>
                  <TableCell>
                    <div className="flex max-w-64 flex-wrap gap-1">
                      {field.allowedValues.slice(0, 4).map((value) => (
                        <Badge key={value} variant="secondary">
                          {value}
                        </Badge>
                      ))}
                      {field.allowedValues.length > 4 ? (
                        <Badge variant="outline">+{field.allowedValues.length - 4}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : null}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editing ? `Edit ${editing.key}` : "Add question"}</SheetTitle>
            <SheetDescription>
              Closed answers only: the agent picks one of the allowed values. Editing a question
              never changes requests that already ran.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="field-key">Key</Label>
              <Input
                id="field-key"
                value={form.key}
                readOnly={editing !== null}
                placeholder="journey.occasion"
                onChange={(event) => setForm({ ...form, key: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {editing
                  ? "The key cannot change after creation."
                  : "Lowercase namespace.name. This is what the SDK and API reference."}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="field-label">Question topic</Label>
              <Input
                id="field-label"
                value={form.label}
                placeholder="Shopping occasion"
                onChange={(event) => setForm({ ...form, label: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Epode inserts this topic into the customer permission question.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="field-type">Type</Label>
              <Input
                id="field-type"
                value={form.type}
                placeholder="preference"
                onChange={(event) => setForm({ ...form, type: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Your own lowercase category, such as preference, goal, constraint, or intent.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="field-values">Allowed values</Label>
              <Input
                id="field-values"
                value={form.allowedValues}
                placeholder="gift, self_purchase, replacement"
                onChange={(event) => setForm({ ...form, allowedValues: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated lowercase snake_case, 1–32 distinct values.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="field-operations">Operations</Label>
              <Input
                id="field-operations"
                value={form.operations}
                placeholder="search_catalog, /search"
                onChange={(event) => setForm({ ...form, operations: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Optional. Comma-separated tool or route names this field may be asked at. Leave
                empty to allow every operation.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="field-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm({ ...form, enabled: checked === true })}
              />
              <Label htmlFor="field-enabled">Enabled</Label>
            </div>
            {formError ? <StatusMessage tone="error">{formError}</StatusMessage> : null}
          </div>
          <SheetFooter>
            <Button type="button" disabled={saving} onClick={() => void submit()}>
              {saving ? "Saving…" : "Save question"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function JourneyDimensions({
  data,
  editor,
  rememberedKeys,
  onRemember,
}: {
  data: DashboardData;
  editor: boolean;
  rememberedKeys: Set<string>;
  onRemember: (category: string) => void;
}) {
  const activity = useMemo(
    () => summarizeExperienceActivity(data.interactions),
    [data.interactions],
  );

  return (
    <Panel title="Journey dimensions">
      <p className="text-sm text-muted-foreground">
        Needs the experience graph elicits per task, computed from recent journey telemetry. When a
        dimension keeps deciding journeys, remember it as a question so future journeys start with
        it already answered.
      </p>
      {activity.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No experience-graph journeys observed yet. When agents negotiate needs through your graph,
          per-dimension activity appears here.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dimension</TableHead>
              <TableHead>Journeys</TableHead>
              <TableHead>Negotiations</TableHead>
              <TableHead>Decisions</TableHead>
              <TableHead>Decision outcomes</TableHead>
              <TableHead>Item views</TableHead>
              <TableHead>Last seen</TableHead>
              {editor ? <TableHead className="w-40" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {activity.map((dimension) => {
              const rememberedKey = contextKeyForCategory(dimension.category);
              const remembered = rememberedKeys.has(rememberedKey);
              return (
                <TableRow key={dimension.category}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm">{titleCase(dimension.category)}</span>
                      <code className="text-xs text-muted-foreground">{dimension.category}</code>
                    </div>
                  </TableCell>
                  <TableCell>{dimension.journeys}</TableCell>
                  <TableCell>{dimension.negotiations}</TableCell>
                  <TableCell>{dimension.decisions}</TableCell>
                  <TableCell>
                    {dimension.decisions === 0 ? (
                      <span className="text-muted-foreground">No decisions yet</span>
                    ) : (
                      <span>
                        {dimension.decided} decided · {dimension.counterfactuals} counterfactual
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{dimension.itemViews}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {dimension.lastSeenAt ? relativeDate(dimension.lastSeenAt) : "—"}
                  </TableCell>
                  {editor ? (
                    <TableCell>
                      {remembered ? (
                        <Badge variant="secondary">Remembered</Badge>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onRemember(dimension.category)}
                        >
                          Remember as question
                        </Button>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
