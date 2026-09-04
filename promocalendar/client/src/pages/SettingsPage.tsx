import { useRef, useState } from "react";
import { Shell } from "../components/Shell";
import { api, type UploadInfo } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { Skeleton, ErrorBanner } from "../components/misc";
import { fmtBytes, fmtDateTime } from "../lib/format";

export default function SettingsPage() {
  const me = useAsync(() => api.me(), []);
  const uploads = useAsync(() => api.uploads(), []);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<null | Awaited<ReturnType<typeof api.upload>>>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const res = await api.upload(file);
      setUploadResult(res);
      uploads.reload();
    } catch (e: unknown) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onRollback = async (id: number) => {
    if (!confirm("Roll back to this upload? The current active upload will be deactivated.")) return;
    try {
      await api.rollback(id);
      uploads.reload();
    } catch (e: unknown) {
      alert((e as Error).message);
    }
  };

  const canUpload = !!me.data?.can_upload;

  return (
    <Shell active="settings" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Settings" }]}>
      <div className="section-h" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>Saber promo calendar</h2>
        <span className="sub">{canUpload ? "You have upload permissions" : "Read-only access"}</span>
      </div>

      <div className="strip">
        <div className="section-h">
          <h2>Upload new workbook</h2>
        </div>
        <div style={{ padding: 20 }}>
          {!canUpload ? (
            <div className="empty" style={{ padding: 20 }}>
              <h3>Upload restricted</h3>
              <p>Upload is limited to the Saber owner (steve@saber3d.com). Contact them to publish a new Promo-Schedule sheet.</p>
            </div>
          ) : (
            <>
              <p style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "0 0 14px" }}>
                Upload a Promo-Schedule .xlsx file. The parser will validate every row and
                report any warnings. The new upload becomes active immediately; previous
                uploads remain in history and can be rolled back to.
              </p>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(f);
                  }}
                  style={{ display: "none" }}
                />
                <button
                  className="btn primary"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? "Uploading…" : "Choose file to upload"}
                </button>
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>.xlsx only · Promo-Schedule sheet required</span>
              </div>
              {uploadError && (
                <div className="empty" style={{ marginTop: 16, borderColor: "rgba(239,68,68,0.35)", color: "#fecaca" }}>
                  <p>{uploadError}</p>
                </div>
              )}
              {uploadResult && (
                <div style={{ marginTop: 16, padding: 16, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Upload successful</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 12 }}>
                    {uploadResult.upload.filename} · {uploadResult.upload.campaigns_count} campaigns · {uploadResult.upload.events_count} events · {uploadResult.upload.parse_warnings.length} warning{uploadResult.upload.parse_warnings.length === 1 ? "" : "s"}
                  </div>
                  {uploadResult.warnings.length > 0 && (
                    <details>
                      <summary style={{ cursor: "pointer", color: "var(--warn)", fontSize: 12.5 }}>
                        {uploadResult.warnings.length} parse warning{uploadResult.warnings.length === 1 ? "" : "s"}
                      </summary>
                      <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-muted)", maxHeight: 200, overflow: "auto" }}>
                        {uploadResult.warnings.slice(0, 50).map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                        {uploadResult.warnings.length > 50 && <li>… and {uploadResult.warnings.length - 50} more</li>}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="strip">
        <div className="section-h">
          <h2>Upload history</h2>
          <span className="sub">{uploads.data?.uploads.length || 0} uploads</span>
        </div>
        {uploads.loading ? (
          <Skeleton height={200} />
        ) : uploads.error ? (
          <ErrorBanner error={uploads.error} />
        ) : !uploads.data?.uploads.length ? (
          <div className="empty" style={{ padding: 24 }}><p>No uploads yet.</p></div>
        ) : (
          <UploadHistoryTable uploads={uploads.data.uploads} onRollback={onRollback} canRollback={canUpload} />
        )}
      </div>
    </Shell>
  );
}

function UploadHistoryTable({
  uploads,
  onRollback,
  canRollback,
}: {
  uploads: UploadInfo[];
  onRollback: (id: number) => void;
  canRollback: boolean;
}) {
  return (
    <div className="term-table-wrap">
      <table className="term">
        <thead>
          <tr>
            <th>Filename</th>
            <th>Uploaded</th>
            <th>By</th>
            <th className="num">Campaigns</th>
            <th className="num">Events</th>
            <th className="num">Warnings</th>
            <th className="num">Size</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {uploads.map((u) => (
            <tr key={u.id} className={u.is_active ? "live" : ""}>
              <td className="prog">
                <a href={api.downloadUrl(u.id)} target="_blank" rel="noreferrer" style={{ color: "var(--text)" }}>
                  {u.filename}
                </a>
              </td>
              <td className="dates">{fmtDateTime(u.uploaded_at)}</td>
              <td>{u.uploaded_by || "—"}</td>
              <td className="num">{u.campaigns_count}</td>
              <td className="num">{u.events_count}</td>
              <td className={`num${u.parse_warnings.length > 0 ? " warn" : ""}`}>{u.parse_warnings.length}</td>
              <td className="num">{fmtBytes(u.file_size_bytes)}</td>
              <td>
                {u.is_active ? (
                  <span className="chip" style={{ background: "rgba(52,211,153,0.15)", color: "var(--ok)", borderColor: "rgba(52,211,153,0.35)" }}>Active</span>
                ) : (
                  <span className="chip">Superseded</span>
                )}
              </td>
              <td>
                {!u.is_active && canRollback && (
                  <button className="btn" onClick={() => onRollback(u.id)}>Roll back</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
