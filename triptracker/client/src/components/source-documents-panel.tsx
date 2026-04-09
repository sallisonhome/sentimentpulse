import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SourceDocument } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FileText, Link2, Upload, AlignLeft,
  Clock, CheckCircle2, XCircle, AlertCircle,
  RefreshCw, Loader2, UploadCloud, Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const sourceTypeConfig = {
  pasted_text:  { label: "Pasted Text", icon: AlignLeft,  color: "text-blue-500" },
  google_doc:   { label: "Google Doc",  icon: Link2,       color: "text-green-500" },
  pdf_file:     { label: "PDF",         icon: FileText,    color: "text-red-500" },
  word_file:    { label: "Word Doc",    icon: Upload,      color: "text-blue-600" },
  other:        { label: "Other",       icon: FileText,    color: "text-muted-foreground" },
};

const parsingStatusConfig = {
  pending:          { label: "Extracting…", icon: Loader2,        classes: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  success:          { label: "Extracted",   icon: CheckCircle2,   classes: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  failed:           { label: "Failed",      icon: XCircle,        classes: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  partially_parsed: { label: "Partial",     icon: AlertCircle,    classes: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
};

interface SourceDocumentsPanelProps {
  eventId: number;
  onIngestClick?: () => void;
}

export function SourceDocumentsPanel({ eventId, onIngestClick }: SourceDocumentsPanelProps) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: docs, isLoading } = useQuery<SourceDocument[]>({
    queryKey: ["/api/events", eventId, "source-documents"],
    queryFn: async () => {
      const r = await fetch(`/api/events/${eventId}/source-documents`);
      return r.json();
    },
    // Poll every 4s while any doc is in "pending" state so UI auto-updates after extraction
    refetchInterval: (query) => {
      const data = query.state.data as SourceDocument[] | undefined;
      if (!data) return false;
      return data.some((d) => d.parsingStatus === "pending") ? 4000 : false;
    },
  });

  // Track which doc IDs are currently being re-extracted
  const [reparsingIds, setReparsingIds] = useState<number[]>([]);
  // Track which doc ID is pending delete confirmation
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // Track locally removed doc IDs so they hide instantly without waiting for cache
  const [removedIds, setRemovedIds] = useState<number[]>([]);

  const deleteMutation = useMutation({
    mutationFn: async (docId: number) => {
      const res = await fetch(`/api/source-documents/${docId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    },
    onMutate: (docId) => {
      // Optimistically remove from cache immediately
      qc.setQueryData(
        ["/api/events", eventId, "source-documents"],
        (old: SourceDocument[] | undefined) => (old ?? []).filter(d => d.id !== docId)
      );
    },
    onSuccess: (_data, docId) => {
      setDeletingId(null);
      qc.invalidateQueries({ queryKey: ["/api/events", eventId, "source-documents"] });
      qc.invalidateQueries({ queryKey: ["/api/events", eventId] });
      toast({ title: "Document removed" });
    },
    onError: (err: any, docId) => {
      setDeletingId(null);
      // Restore on error
      qc.invalidateQueries({ queryKey: ["/api/events", eventId, "source-documents"] });
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const parseMutation = useMutation({
    mutationFn: async (docId: number) => {
      const res = await fetch(`/api/source-documents/${docId}/parse`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    onMutate: (docId) => {
      setReparsingIds(prev => [...prev, docId]);
    },
    onSuccess: (_data, docId) => {
      setReparsingIds(prev => prev.filter(id => id !== docId));
      qc.invalidateQueries({ queryKey: ["/api/events", eventId, "source-documents"] });
      qc.invalidateQueries({ queryKey: ["/api/events", eventId, "meetings"] });
      qc.invalidateQueries({ queryKey: ["/api/events", eventId] });
      qc.invalidateQueries({ queryKey: ["/api/events", eventId, "executive-summary"] });
    },
    onError: (err: any, docId) => {
      setReparsingIds(prev => prev.filter(id => id !== docId));
      toast({ title: "Re-extract failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card data-testid="panel-source-documents">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center justify-between">
          <span className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" />
            Source Documents
          </span>
          {docs && <Badge variant="secondary" className="text-xs">{docs.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <p className="text-xs text-muted-foreground">Loading...</p>}
        {docs?.length === 0 && (
          <p className="text-xs text-muted-foreground py-2">
            No source documents yet. Use "Ingest Report" to add one.
          </p>
        )}
        {docs?.filter(d => !removedIds.includes(d.id)).map((doc) => {
          const stc = sourceTypeConfig[doc.sourceType] ?? sourceTypeConfig.other;
          const psc = parsingStatusConfig[doc.parsingStatus];
          const Icon = stc.icon;
          const StatusIcon = psc.icon;
          const isPending = doc.parsingStatus === "pending";
          const isReparsing = reparsingIds.includes(doc.id);
          const isFailed = doc.parsingStatus === "failed" || doc.parsingStatus === "partially_parsed";
          // Can re-run AI extraction if raw text exists
          const canReparse = !isPending && !isReparsing && !!doc.rawText;
          // Can re-upload if failed/partial but no raw text stored (e.g. OOM during original upload)
          const canReupload = isFailed && !doc.rawText && !isPending && !isReparsing;

          return (
            <div
              key={doc.id}
              className="flex items-start gap-3 p-2.5 rounded-md bg-muted/40"
              data-testid={`doc-item-${doc.id}`}
            >
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${stc.color}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium truncate">
                    {doc.originalFileName ?? doc.externalUrl?.slice(0, 40) ?? stc.label}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${psc.classes}`}
                  >
                    <StatusIcon className={`w-3 h-3 ${isPending || isReparsing ? "animate-spin" : ""}`} />
                    {isReparsing ? "Extracting…" : psc.label}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {stc.label} · {format(new Date(doc.uploadedAt), "MMM d, yyyy")}
                </p>
                {doc.parsingLog && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2 italic">
                    {doc.parsingLog}
                  </p>
                )}
                {doc.rawTextExcerpt && !doc.parsingLog?.startsWith("AI extraction") && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-1 font-mono leading-tight">
                    {doc.rawTextExcerpt}
                  </p>
                )}
                {(canReparse || isReparsing) && (
                  <button
                    className="inline-flex items-center gap-1 h-6 px-2 text-xs mt-1 text-muted-foreground hover:text-foreground rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      parseMutation.mutate(doc.id);
                    }}
                    disabled={isReparsing}
                    data-testid={`button-reparse-${doc.id}`}
                  >
                    {isReparsing
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <RefreshCw className="w-3 h-3" />
                    }
                    {isReparsing ? "Extracting…" : "Re-extract"}
                  </button>
                )}
                {canReupload && (
                  <button
                    className="inline-flex items-center gap-1 h-6 px-2 text-xs mt-1 text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 rounded cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onIngestClick?.();
                    }}
                    data-testid={`button-reupload-${doc.id}`}
                  >
                    <UploadCloud className="w-3 h-3" />
                    Re-upload file
                  </button>
                )}
                {/* Delete */}
                {deletingId === doc.id ? (
                  <span className="inline-flex items-center gap-1.5 mt-1 text-xs">
                    <span className="text-red-600 dark:text-red-400 font-medium">Remove this document?</span>
                    <button
                      className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-semibold cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const id = doc.id;
                        // Hide immediately via local state — works regardless of cache/polling
                        setRemovedIds(prev => [...prev, id]);
                        setDeletingId(null);
                        // Fire DELETE in background
                        fetch(`/api/source-documents/${id}`, { method: "DELETE" })
                          .then(r => {
                            if (!r.ok) throw new Error(`${r.status}`);
                            qc.invalidateQueries({ queryKey: ["/api/events", eventId, "source-documents"] });
                            qc.invalidateQueries({ queryKey: ["/api/events", eventId] });
                            toast({ title: "Document removed" });
                          })
                          .catch(err => {
                            // Restore on error
                            setRemovedIds(prev => prev.filter(x => x !== id));
                            toast({ title: "Delete failed", description: err.message, variant: "destructive" });
                          });
                      }}
                      data-testid={`button-confirm-delete-${doc.id}`}
                    >
                      Yes, remove
                    </button>
                    <button
                      className="text-muted-foreground hover:text-foreground cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); setDeletingId(null); }}
                      data-testid={`button-cancel-delete-${doc.id}`}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="inline-flex items-center gap-1 h-6 px-2 text-xs mt-1 text-muted-foreground hover:text-red-500 dark:hover:text-red-400 rounded cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); setDeletingId(doc.id); }}
                    data-testid={`button-delete-${doc.id}`}
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
