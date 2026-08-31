// Thin fetch wrapper. Base URL is `/partnerships/api` in production and dev
// (Vite proxies both under the same nginx path, and dev mode uses the same
// path since the Express server hosts both the API and the Vite middleware).

const BASE = "/partnerships/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${path}: ${text}`);
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => req<{ ok: boolean; app: string; version: string }>("/health"),
  titles: () => req<import("@shared/schema").PartnershipsTitle[]>("/titles"),
  title: (id: number) =>
    req<import("@shared/schema").PartnershipsTitle>(`/titles/${id}`),
  dashboard: () => req<import("@shared/schema").DashboardRow[]>("/dashboard"),
  pdp: (productId: number) =>
    req<import("@shared/schema").PdpPayload>(`/pdp/${productId}`),

  createOpportunity: (body: unknown) =>
    req<import("@shared/schema").Opportunity>("/opportunities", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateOpportunity: (id: string, body: unknown) =>
    req<import("@shared/schema").Opportunity>(`/opportunities/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  removeOpportunity: (id: string, reason: string) =>
    req<import("@shared/schema").Opportunity>(`/opportunities/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),

  createRetailPartner: (body: unknown) =>
    req<import("@shared/schema").PhysicalRetailPartner>("/retail-partners", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateRetailPartner: (id: string, body: unknown) =>
    req<import("@shared/schema").PhysicalRetailPartner>(
      `/retail-partners/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  removeRetailPartner: (id: string, reason: string) =>
    req<import("@shared/schema").PhysicalRetailPartner>(
      `/retail-partners/${id}`,
      { method: "DELETE", body: JSON.stringify({ reason }) },
    ),

  createCEItem: (body: unknown) =>
    req<import("@shared/schema").CollectorsEditionItem>("/ce-items", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteCEItem: (id: string) =>
    req<null>(`/ce-items/${id}`, { method: "DELETE" }),
};
