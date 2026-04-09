import { useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { FileText, Link2, Upload, AlignLeft, CheckCircle2, Loader2 } from "lucide-react";
import type { EventWithStats } from "@shared/schema";

const API_BASE = (import.meta.env.VITE_API_BASE as string) ?? "";

interface IngestModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId?: number | null;
  eventName?: string;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function charLabel(n: number) {
  return n > 0 ? `${n.toLocaleString()} characters extracted` : null;
}

// ── File drop zone component ───────────────────────────────────────────────────

function FileDropZone({
  accept, label, icon: Icon, onFile, file, loading,
}: {
  accept: string;
  label: string;
  icon: React.ElementType;
  onFile: (f: File) => void;
  file: File | null;
  loading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }, [onFile]);

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
        ${dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/40"}
        ${file ? "border-emerald-500/50 bg-emerald-500/5" : ""}`}
      onClick={() => !loading && inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={e => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      {file ? (
        <div className="flex flex-col items-center gap-1">
          <CheckCircle2 className="w-7 h-7 text-emerald-500" />
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400 truncate max-w-xs">{file.name}</p>
          <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB — click to replace</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <Icon className="w-8 h-8 opacity-30" />
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">Drag & drop or click to browse</p>
        </div>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function IngestModal({ open, onOpenChange, eventId: lockedEventId, eventName }: IngestModalProps) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: events } = useQuery<EventWithStats[]>({ queryKey: ["/api/events"] });
  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const resolvedEventId = lockedEventId ?? (selectedEventId ? parseInt(selectedEventId) : null);
  const resolvedEventName = eventName ?? events?.find(e => e.id === resolvedEventId)?.name ?? "";

  const [pastedText, setPastedText] = useState("");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [wordFile, setWordFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);

  const noEvent = !resolvedEventId;

  const reset = () => {
    setPastedText("");
    setGoogleDocUrl("");
    setPdfFile(null);
    setWordFile(null);
    setSelectedEventId("");
    setLoading(false);
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/events"] });
    if (resolvedEventId) {
      qc.invalidateQueries({ queryKey: [`/api/events/${resolvedEventId}/source-documents`] });
    }
  };

  const handleSuccess = (fileName: string, charCount: number) => {
    invalidate();
    const info = charCount > 0
      ? ` ${charCount.toLocaleString()} characters saved.`
      : " Saved with metadata.";
    toast({ title: "Report saved", description: `${fileName} added to ${resolvedEventName}.${info}` });
    onOpenChange(false);
    reset();
  };

  const handleError = (msg: string) => {
    toast({ title: "Upload failed", description: msg, variant: "destructive" });
    setLoading(false);
  };

  // ── Paste ──────────────────────────────────────────────────────────────────

  const handlePasteSubmit = async () => {
    if (!pastedText.trim() || noEvent) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/source-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: resolvedEventId,
          sourceType: "pasted_text",
          rawText: pastedText,
          rawTextExcerpt: pastedText.slice(0, 400),
          uploadedByUserId: 1,
          parsingStatus: "success",
        }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? res.statusText);
      handleSuccess("Pasted text", pastedText.length);
    } catch (err: any) {
      handleError(err.message ?? "Please try again.");
    }
  };

  // ── Google Doc ─────────────────────────────────────────────────────────────

  const handleGoogleDocSubmit = async () => {
    if (!googleDocUrl.trim() || noEvent) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/fetch-google-doc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: googleDocUrl,
          eventId: resolvedEventId,
          uploadedByUserId: 1,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? res.statusText);
      const doc = await res.json();
      handleSuccess("Google Doc", doc.characterCount ?? 0);
    } catch (err: any) {
      handleError(err.message ?? "Could not fetch document.");
    }
  };

  // ── File upload (PDF / Word) ───────────────────────────────────────────────

  const handleFileSubmit = async (file: File, sourceType: "pdf_file" | "word_file") => {
    if (!file || noEvent) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("eventId", String(resolvedEventId));
      formData.append("uploadedByUserId", "1");

      const res = await fetch(`${API_BASE}/api/upload-document`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error((await res.json()).message ?? res.statusText);
      const doc = await res.json();
      handleSuccess(file.name, doc.characterCount ?? 0);
    } catch (err: any) {
      handleError(err.message ?? "Please try again.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-xl" data-testid="modal-ingest">
        <DialogHeader>
          <DialogTitle>Upload Trip Report</DialogTitle>
          <DialogDescription>
            {lockedEventId
              ? <>Add a report to <strong>{eventName}</strong>.</>
              : "Select an event, then submit your trip report in any format."}
          </DialogDescription>
        </DialogHeader>

        {/* Event selector */}
        {!lockedEventId && (
          <div className="space-y-1.5">
            <Label>Event</Label>
            <Select value={selectedEventId} onValueChange={setSelectedEventId}>
              <SelectTrigger data-testid="select-ingest-event">
                <SelectValue placeholder="Select an event..." />
              </SelectTrigger>
              <SelectContent>
                {(events ?? []).map(e => (
                  <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Tabs defaultValue="paste" className="mt-1">
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="paste"><AlignLeft className="w-3.5 h-3.5 mr-1" />Paste</TabsTrigger>
            <TabsTrigger value="google"><Link2 className="w-3.5 h-3.5 mr-1" />Google Doc</TabsTrigger>
            <TabsTrigger value="pdf"><FileText className="w-3.5 h-3.5 mr-1" />PDF</TabsTrigger>
            <TabsTrigger value="word"><Upload className="w-3.5 h-3.5 mr-1" />Word</TabsTrigger>
          </TabsList>

          {/* ── Paste ── */}
          <TabsContent value="paste" className="space-y-3 mt-3">
            <Textarea
              placeholder="Paste your trip report, meeting notes, or email thread here..."
              className="min-h-[180px] font-mono text-sm"
              value={pastedText}
              onChange={e => setPastedText(e.target.value)}
              disabled={loading}
            />
            {pastedText.length > 0 && (
              <p className="text-xs text-muted-foreground">{charLabel(pastedText.length)}</p>
            )}
            <Button
              onClick={handlePasteSubmit}
              disabled={!pastedText.trim() || loading || noEvent}
              className="w-full"
            >
              {loading ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Saving...</> : "Save Pasted Report"}
            </Button>
          </TabsContent>

          {/* ── Google Doc ── */}
          <TabsContent value="google" className="space-y-3 mt-3">
            <Label>Google Docs URL</Label>
            <Input
              placeholder="https://docs.google.com/document/d/..."
              value={googleDocUrl}
              onChange={e => setGoogleDocUrl(e.target.value)}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              The document must be shared as <strong>Anyone with the link can view</strong>. The full text will be fetched and saved.
            </p>
            <Button
              onClick={handleGoogleDocSubmit}
              disabled={!googleDocUrl.trim() || loading || noEvent}
              className="w-full"
            >
              {loading ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Fetching doc...</> : "Fetch & Save Google Doc"}
            </Button>
          </TabsContent>

          {/* ── PDF ── */}
          <TabsContent value="pdf" className="space-y-3 mt-3">
            <FileDropZone
              accept=".pdf,.txt,.md"
              label="Drop PDF or text file here"
              icon={FileText}
              onFile={(f) => { setPdfFile(f); handleFileSubmit(f, "pdf_file"); }}
              file={pdfFile}
              loading={loading}
            />
            <p className="text-xs text-muted-foreground">
              Supported: .pdf, .txt, .md — drop the file to auto-upload, or click to browse.
            </p>
            <Button
              onClick={() => pdfFile && handleFileSubmit(pdfFile, "pdf_file")}
              disabled={!pdfFile || loading || noEvent}
              className="w-full"
            >
              {loading ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Extracting text...</> : "Upload & Extract PDF"}
            </Button>
          </TabsContent>

          {/* ── Word ── */}
          <TabsContent value="word" className="space-y-3 mt-3">
            <FileDropZone
              accept=".docx,.doc,.txt,.md"
              label="Drop Word doc or text file here"
              icon={Upload}
              onFile={(f) => { setWordFile(f); handleFileSubmit(f, "word_file"); }}
              file={wordFile}
              loading={loading}
            />
            <p className="text-xs text-muted-foreground">
              Supported: .docx, .doc, .txt, .md — drop the file to auto-upload, or click to browse.
            </p>
            <Button
              onClick={() => wordFile && handleFileSubmit(wordFile, "word_file")}
              disabled={!wordFile || loading || noEvent}
              className="w-full"
            >
              {loading ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Extracting text...</> : "Upload & Extract Word Doc"}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
