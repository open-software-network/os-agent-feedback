import { apiRequest } from "@/lib/api/client";

export type ContextFieldDefinition = {
  key: string;
  label: string;
  type: string;
  allowedValues: string[];
  targetedAdvertisingSafe: boolean;
  operations: string[] | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ContextFieldList = {
  fields: ContextFieldDefinition[];
  legacyCatalogActive: boolean;
};

export type ContextFieldInput = {
  label: string;
  type: string;
  allowedValues: string[];
  targetedAdvertisingSafe: boolean;
  operations: string[] | null;
  enabled: boolean;
};

export function listContextFields(
  productId: string,
  workspaceId: string,
): Promise<ContextFieldList> {
  return apiRequest<ContextFieldList>(`/api/products/${productId}/context-fields`, {
    workspaceId,
  });
}

export function saveContextField(
  productId: string,
  key: string,
  input: ContextFieldInput,
  workspaceId: string,
): Promise<ContextFieldDefinition> {
  return apiRequest<ContextFieldDefinition>(
    `/api/products/${productId}/context-fields/${encodeURIComponent(key)}`,
    { method: "PUT", body: JSON.stringify(input), workspaceId },
  );
}

export function deleteContextField(
  productId: string,
  key: string,
  workspaceId: string,
): Promise<ContextFieldDefinition> {
  return apiRequest<ContextFieldDefinition>(
    `/api/products/${productId}/context-fields/${encodeURIComponent(key)}`,
    { method: "DELETE", workspaceId },
  );
}
