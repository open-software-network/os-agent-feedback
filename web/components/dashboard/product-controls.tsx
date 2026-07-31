"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { StatusMessage } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/api/client";
import type {
  DashboardData,
  DeleteProductInput,
  ProductCreatedResponse,
  ProductDeletedResponse,
  ProductResponse,
  UpdateNameInput,
} from "@/lib/api/dashboard";
import { isEditor } from "@/lib/dashboard/format";

const nameSchema = z.object({ name: z.string().trim().min(1, "Enter a name") });
const deleteSchema = z.object({ confirmation: z.string() });

type ProductControlsProps = {
  data: DashboardData;
  onProductCreated: (created: ProductCreatedResponse) => Promise<void>;
  onProductDeleted: () => Promise<void>;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
};

export function ProductControls({
  data,
  onProductCreated,
  onProductDeleted,
  refresh,
  setNotice,
}: ProductControlsProps) {
  const [mode, setMode] = useState<"closed" | "create" | "rename" | "delete">("closed");
  const [error, setError] = useState("");
  const createForm = useForm<z.infer<typeof nameSchema>>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: "" },
  });
  const renameForm = useForm<z.infer<typeof nameSchema>>({
    resolver: zodResolver(nameSchema),
    values: { name: data.currentProduct?.name ?? "" },
  });
  const deleteForm = useForm<z.infer<typeof deleteSchema>>({
    resolver: zodResolver(deleteSchema),
    defaultValues: { confirmation: "" },
  });

  if (!isEditor(data.currentRole)) return null;

  async function submitCreate(values: z.infer<typeof nameSchema>) {
    setError("");
    try {
      const created = await apiRequest<ProductCreatedResponse>("/api/products", {
        method: "POST",
        workspaceId: data.workspace.id,
        body: JSON.stringify(values),
      });
      createForm.reset();
      setMode("closed");
      setNotice(`${created.product.name} created. Copy its write key now; it is shown once.`);
      await onProductCreated(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create product");
    }
  }

  async function submitRename(values: z.infer<typeof nameSchema>) {
    if (!data.currentProduct) return;
    setError("");
    try {
      const input: UpdateNameInput = values;
      await apiRequest<ProductResponse>(`/api/products/${data.currentProduct.id}`, {
        method: "PATCH",
        workspaceId: data.workspace.id,
        body: JSON.stringify(input),
      });
      setMode("closed");
      setNotice("Product renamed.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename product");
    }
  }

  async function submitDelete(values: z.infer<typeof deleteSchema>) {
    if (!data.currentProduct) return;
    setError("");
    if (values.confirmation !== data.currentProduct.name) {
      deleteForm.setError("confirmation", {
        message: `Type ${data.currentProduct.name} exactly`,
      });
      return;
    }
    try {
      const input: DeleteProductInput = values;
      await apiRequest<ProductDeletedResponse>(`/api/products/${data.currentProduct.id}`, {
        method: "DELETE",
        workspaceId: data.workspace.id,
        body: JSON.stringify(input),
      });
      deleteForm.reset();
      setMode("closed");
      setNotice("Product deleted.");
      await onProductDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete product");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setMode("create")}>
          New product
        </Button>
        {data.currentProduct ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode("rename")}>
              Rename
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setMode("delete")}>
              Delete
            </Button>
          </>
        ) : null}
      </div>

      {mode === "create" ? (
        <form
          className="flex max-w-md items-end gap-2"
          onSubmit={createForm.handleSubmit(submitCreate)}
        >
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="create-product-name">Product name</Label>
            <Input id="create-product-name" {...createForm.register("name")} />
            <FormError message={createForm.formState.errors.name?.message} />
          </div>
          <Button type="submit" disabled={createForm.formState.isSubmitting}>
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("closed")}>
            Cancel
          </Button>
        </form>
      ) : null}

      {mode === "rename" && data.currentProduct ? (
        <form
          className="flex max-w-md items-end gap-2"
          onSubmit={renameForm.handleSubmit(submitRename)}
        >
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="rename-product-name">New name</Label>
            <Input id="rename-product-name" {...renameForm.register("name")} />
            <FormError message={renameForm.formState.errors.name?.message} />
          </div>
          <Button type="submit" disabled={renameForm.formState.isSubmitting}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("closed")}>
            Cancel
          </Button>
        </form>
      ) : null}

      {mode === "delete" && data.currentProduct ? (
        <form
          className="flex max-w-md flex-col gap-2"
          onSubmit={deleteForm.handleSubmit(submitDelete)}
        >
          <Label htmlFor="delete-product-confirmation">
            Type <strong>{data.currentProduct.name}</strong> to confirm deletion
          </Label>
          <div className="flex gap-2">
            <Input
              id="delete-product-confirmation"
              autoComplete="off"
              {...deleteForm.register("confirmation")}
            />
            <Button
              type="submit"
              variant="destructive"
              disabled={deleteForm.formState.isSubmitting}
            >
              Delete product
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("closed")}>
              Cancel
            </Button>
          </div>
          <FormError message={deleteForm.formState.errors.confirmation?.message} />
        </form>
      ) : null}

      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
    </div>
  );
}

function FormError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}
