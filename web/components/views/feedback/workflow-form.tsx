"use client";

import { IconCalendarCheck } from "central-icons/IconCalendarCheck";
import { IconCheckCircle2 } from "central-icons/IconCheckCircle2";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCircle } from "central-icons/IconCircle";
import { IconCircleMinus } from "central-icons/IconCircleMinus";
import { IconCirclePerson } from "central-icons/IconCirclePerson";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPageText } from "central-icons/IconPageText";
import { IconTag } from "central-icons/IconTag";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/api/client";
import type {
  DashboardData,
  ProductFeedbackReport,
  TeamMember,
  UpdatedResponse,
  UpdateFeedbackWorkflowInput,
} from "@/lib/api/dashboard";
import { isEditor } from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";

import { type WorkflowStatus, workflowLabels, workflowStatuses } from "./feedback-filters";

type SemanticIcon = ComponentType<{
  className?: string;
  size?: number;
  "aria-hidden"?: boolean;
  "data-icon"?: string;
}>;

export const workflowIcons: Record<WorkflowStatus, SemanticIcon> = {
  new: IconCircle,
  investigating: IconMagnifyingGlass,
  planned: IconCalendarCheck,
  resolved: IconCheckCircle2,
  wont_act: IconCircleMinus,
};

type WorkflowValues = {
  status: WorkflowStatus;
  assigneeOsUserId: string | null;
  tags: string[];
  internalNote: string;
};

type WorkflowField = "status" | "assignee" | "tags" | "note";

const unassignedValue = "__unassigned__";

const propertyTrigger =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60";
const propertyValue = "inline-flex h-7 max-w-full items-center gap-1.5 px-2 text-sm";

export function WorkflowMetadata({
  data,
  report,
  impact,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  report: ProductFeedbackReport;
  impact: ReactNode;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const editable = isEditor(data.currentRole);
  const [values, setValues] = useState<WorkflowValues>(() => valuesForReport(report));
  const valuesRef = useRef(values);
  const pendingRef = useRef(false);
  const [pendingField, setPendingField] = useState<WorkflowField | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const next = valuesForReport(report);
    valuesRef.current = next;
    setValues(next);
    setError("");
  }, [report]);

  async function save(
    field: WorkflowField,
    patch: Partial<WorkflowValues>,
    notice: string,
  ): Promise<boolean> {
    if (!data.currentProduct || pendingRef.current) return false;
    const previous = valuesRef.current;
    const next = { ...previous, ...patch };
    pendingRef.current = true;
    valuesRef.current = next;
    setValues(next);
    setPendingField(field);
    setError("");

    try {
      const input: UpdateFeedbackWorkflowInput = {
        productId: data.currentProduct.id,
        status: next.status,
        assigneeOsUserId: next.assigneeOsUserId,
        tags: next.tags,
        internalNote: next.internalNote.trim() || null,
      };
      await apiRequest<UpdatedResponse>(`/api/dashboard/reports/${report.id}`, {
        method: "PATCH",
        workspaceId: data.workspace.id,
        body: JSON.stringify(input),
      });
      setNotice(notice);
      await refresh();
      return true;
    } catch (caught) {
      valuesRef.current = previous;
      setValues(previous);
      setError(caught instanceof Error ? caught.message : "Could not update feedback workflow");
      return false;
    } finally {
      pendingRef.current = false;
      setPendingField(null);
    }
  }

  return (
    <section aria-labelledby={`feedback-workflow-${report.id}`}>
      <h3 id={`feedback-workflow-${report.id}`} className="text-xs font-medium">
        Team workflow
      </h3>
      <dl className="mt-2 flex flex-col gap-1">
        <MetadataRow label="Impact">{impact}</MetadataRow>
        <MetadataRow label="Status">
          {editable ? (
            <StatusEditor
              value={values.status}
              disabled={pendingField !== null}
              onChange={(status) => save("status", { status }, "Workflow status updated.")}
            />
          ) : (
            <StatusValue value={values.status} />
          )}
        </MetadataRow>
        <MetadataRow label="Assignee">
          {editable ? (
            <AssigneeEditor
              value={values.assigneeOsUserId}
              members={data.teamMembers}
              disabled={pendingField !== null}
              onChange={(assigneeOsUserId) =>
                save("assignee", { assigneeOsUserId }, "Assignee updated.")
              }
            />
          ) : (
            <AssigneeValue value={values.assigneeOsUserId} members={data.teamMembers} />
          )}
        </MetadataRow>
        <MetadataRow label="Tags">
          {editable ? (
            <TagsEditor
              value={values.tags}
              disabled={pendingField !== null}
              saving={pendingField === "tags"}
              onSave={(tags) => save("tags", { tags }, "Tags updated.")}
            />
          ) : (
            <TagsValue value={values.tags} />
          )}
        </MetadataRow>
        {editable ? (
          <MetadataRow label="Internal note">
            <NoteEditor
              value={values.internalNote}
              disabled={pendingField !== null}
              saving={pendingField === "note"}
              onSave={(internalNote) => save("note", { internalNote }, "Internal note saved.")}
            />
          </MetadataRow>
        ) : null}
      </dl>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function MetadataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center text-sm">{children}</dd>
    </div>
  );
}

function StatusEditor({
  value,
  disabled,
  onChange,
}: {
  value: WorkflowStatus;
  disabled: boolean;
  onChange: (value: WorkflowStatus) => Promise<boolean>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Change workflow status, currently ${workflowLabels[value]}`}
            disabled={disabled}
            className={cn(propertyTrigger, "text-foreground")}
          />
        }
      >
        <StatusValue value={value} className="h-auto px-0" />
        <IconChevronDownSmall size={12} className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (workflowStatuses.includes(next as WorkflowStatus)) {
              void onChange(next as WorkflowStatus);
            }
          }}
        >
          {workflowStatuses.map((status) => {
            const StatusIcon = workflowIcons[status];
            return (
              <DropdownMenuRadioItem key={status} value={status}>
                <StatusIcon size={14} />
                {workflowLabels[status]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusValue({ value, className }: { value: WorkflowStatus; className?: string }) {
  const StatusIcon = workflowIcons[value];
  return (
    <span className={cn(propertyValue, className)}>
      <StatusIcon size={14} />
      <span className="truncate">{workflowLabels[value]}</span>
    </span>
  );
}

function AssigneeEditor({
  value,
  members,
  disabled,
  onChange,
}: {
  value: string | null;
  members: TeamMember[];
  disabled: boolean;
  onChange: (value: string | null) => Promise<boolean>;
}) {
  const selectedValue = value ?? unassignedValue;
  const selectedMember = members.find((member) => member.osUserId === value);
  const selectedLabel = selectedMember?.displayName ?? (value ? "Unknown teammate" : "Unassigned");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Change assignee, currently ${selectedLabel}`}
            disabled={disabled}
            className={propertyTrigger}
          />
        }
      >
        <AssigneeValue value={value} members={members} className="h-auto px-0" />
        <IconChevronDownSmall size={12} className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          value={selectedValue}
          onValueChange={(next) => void onChange(next === unassignedValue ? null : next)}
        >
          <DropdownMenuRadioItem value={unassignedValue}>
            <IconCirclePerson size={16} className="text-muted-foreground" />
            <span className="text-muted-foreground">Unassigned</span>
          </DropdownMenuRadioItem>
          {members.map((member) => (
            <DropdownMenuRadioItem key={member.osUserId} value={member.osUserId}>
              <MemberAvatar member={member} />
              <span className="truncate">{member.displayName}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AssigneeValue({
  value,
  members,
  className,
}: {
  value: string | null;
  members: TeamMember[];
  className?: string;
}) {
  const member = members.find((candidate) => candidate.osUserId === value);
  if (!member) {
    return (
      <span className={cn(propertyValue, "text-muted-foreground", className)}>
        <IconCirclePerson size={16} />
        <span>{value ? "Unknown teammate" : "Unassigned"}</span>
      </span>
    );
  }
  return (
    <span className={cn(propertyValue, className)}>
      <MemberAvatar member={member} />
      <span className="truncate">{member.displayName}</span>
    </span>
  );
}

function MemberAvatar({ member }: { member: TeamMember }) {
  return (
    <Avatar size="sm" className="size-4">
      <AvatarFallback className="text-[9px]">{initials(member.displayName)}</AvatarFallback>
    </Avatar>
  );
}

function TagsEditor({
  value,
  disabled,
  saving,
  onSave,
}: {
  value: string[];
  disabled: boolean;
  saving: boolean;
  onSave: (value: string[]) => Promise<boolean>;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value.join(", "));

  useEffect(() => {
    if (!open) setDraft(value.join(", "));
  }, [open, value]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSave(normalizeTags(draft))) setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(value.join(", "));
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Edit tags, currently ${value.length ? value.join(", ") : "none"}`}
            disabled={disabled}
            className={propertyTrigger}
          />
        }
      >
        <TagsValue value={value} className="h-auto px-0" />
        <IconChevronDownSmall size={12} className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <PopoverTitle>Tags</PopoverTitle>
        <PopoverDescription>Separate tags with commas.</PopoverDescription>
        <form className="grid gap-2" onSubmit={submit}>
          <Label className="sr-only" htmlFor={inputId}>
            Tags
          </Label>
          <Input
            id={inputId}
            value={draft}
            maxLength={260}
            placeholder="knowledge, freshness"
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" size="sm" className="w-fit" disabled={disabled || saving}>
            Apply tags
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function TagsValue({ value, className }: { value: string[]; className?: string }) {
  return (
    <span className={cn(propertyValue, value.length === 0 && "text-muted-foreground", className)}>
      <IconTag size={14} />
      <span className="truncate" title={value.join(", ")}>
        {value.length ? value.join(", ") : "No tags"}
      </span>
    </span>
  );
}

function NoteEditor({
  value,
  disabled,
  saving,
  onSave,
}: {
  value: string;
  disabled: boolean;
  saving: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSave(draft.trim())) setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(value);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Edit internal note"
            disabled={disabled}
            className={propertyTrigger}
          />
        }
      >
        <span className={cn(propertyValue, "h-auto px-0", !value && "text-muted-foreground")}>
          <IconPageText size={14} />
          <span className="truncate" title={value}>
            {value || "Add note"}
          </span>
        </span>
        <IconChevronDownSmall size={12} className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle>Internal note</PopoverTitle>
        <PopoverDescription>Only your team can see this note.</PopoverDescription>
        <form className="grid gap-2" onSubmit={submit}>
          <Label className="sr-only" htmlFor={inputId}>
            Internal note
          </Label>
          <Textarea
            id={inputId}
            value={draft}
            maxLength={1000}
            rows={4}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" size="sm" className="w-fit" disabled={disabled || saving}>
            Save note
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function valuesForReport(report: ProductFeedbackReport): WorkflowValues {
  const status = workflowStatuses.find((candidate) => candidate === report.workflowStatus) ?? "new";
  return {
    status,
    assigneeOsUserId: report.assigneeOsUserId ?? null,
    tags: report.tags,
    internalNote: report.internalNote ?? "",
  };
}

function normalizeTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
