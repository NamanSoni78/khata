"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toast } from "sonner";
import {
  Plus, Save, Undo, Redo, Network, X, Loader2, MessageSquare,
} from "lucide-react";

interface MindmapMeta { id: string; name: string; createdAt: string; updatedAt: string; }

interface PendingProposal {
  mindmapId: string;
  mindmapName: string;
  nodes: Node[];
  edges: Edge[];
  summary: string;
  source: string; // raw tool result
}

export default function MindmapEditor() {
  const [mindmaps, setMindmaps] = useState<MindmapMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState<string>("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // === Undo / Redo (history stack of {nodes, edges}) ===
  const [past, setPast] = useState<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const [dirty, setDirty] = useState(false);

  // === Form-edit dialog state ===
  const [editingNode, setEditingNode] = useState<Node | null>(null);
  const [formLabel, setFormLabel] = useState("");
  const [formIsCreating, setFormIsCreating] = useState(false);

  // === Agentic edit chat state ===
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(null);

  const [loadingList, setLoadingList] = useState(true);
  const [saving, setSaving] = useState(false);

  // --- Helpers ---
  const snapshot = useCallback(() => {
    setPast((p) => [...p.slice(-49), { nodes, edges }]);
    setFuture([]);
    setDirty(true);
  }, [nodes, edges]);

  const loadMindmaps = useCallback(async () => {
    setLoadingList(true);
    const res = await fetch("/api/dashboard/mindmaps");
    if (res.ok) {
      const j = await res.json();
      setMindmaps(j.mindmaps ?? []);
    }
    setLoadingList(false);
  }, []);

  useEffect(() => {
    loadMindmaps();
  }, [loadMindmaps]);

  const openMindmap = useCallback(async (id: string) => {
    const res = await fetch(`/api/dashboard/mindmaps/${id}`);
    if (!res.ok) {
      toast.error("Failed to load mindmap");
      return;
    }
    const j = await res.json();
    setActiveId(j.id);
    setName(j.name);
    setNodes(j.nodes ?? []);
    setEdges(j.edges ?? []);
    setPast([]);
    setFuture([]);
    setDirty(false);
    setPendingProposal(null);
    setChatHistory([]);
  }, []);

  const createBlank = useCallback(async () => {
    const res = await fetch("/api/dashboard/mindmaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Mindmap ${new Date().toLocaleString("en-IN")}`, nodes: [], edges: [] }),
    });
    if (!res.ok) {
      toast.error("Failed to create mindmap");
      return;
    }
    const j = await res.json();
    await loadMindmaps();
    await openMindmap(j.id);
    toast.success("New mindmap created");
  }, [loadMindmaps, openMindmap]);

  // --- React Flow handlers ---
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    snapshot();
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, [snapshot]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    snapshot();
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, [snapshot]);

  const onConnect = useCallback((connection: Connection) => {
    snapshot();
    setEdges((eds) => addEdge({ ...connection, id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` }, eds));
  }, [snapshot]);

  // --- Form-based edit ---
  const startAddNode = useCallback(() => {
    setEditingNode(null);
    setFormLabel("");
    setFormIsCreating(true);
  }, []);

  const startEditNode = useCallback((node: Node) => {
    setEditingNode(node);
    setFormLabel(String(node.data?.label ?? ""));
    setFormIsCreating(false);
  }, []);

  const submitForm = useCallback(() => {
    if (!formLabel.trim()) {
      toast.error("Label cannot be empty");
      return;
    }
    snapshot();
    if (editingNode) {
      // Edit existing
      setNodes((nds) =>
        nds.map((n) => (n.id === editingNode.id ? { ...n, data: { ...n.data, label: formLabel } } : n))
      );
      toast.success("Node updated");
    } else {
      // Create new
      const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newNode: Node = {
        id,
        type: "default",
        position: { x: 80 + Math.random() * 240, y: 80 + Math.random() * 200 },
        data: { label: formLabel },
      };
      setNodes((nds) => [...nds, newNode]);
      toast.success("Node added");
    }
    setEditingNode(null);
    setFormLabel("");
    setFormIsCreating(false);
  }, [editingNode, formLabel, snapshot]);

  const deleteSelectedNode = useCallback((id: string) => {
    snapshot();
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
  }, [snapshot]);

  // --- Undo / Redo ---
  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [...f, { nodes, edges }]);
      setNodes(prev.nodes);
      setEdges(prev.edges);
      setDirty(true);
      return p.slice(0, -1);
    });
  }, [nodes, edges]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setPast((p) => [...p, { nodes, edges }]);
      setNodes(next.nodes);
      setEdges(next.edges);
      setDirty(true);
      return f.slice(0, -1);
    });
  }, [nodes, edges]);

  // --- Save (explicit) ---
  const save = useCallback(async () => {
    if (!activeId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/dashboard/mindmaps?id=${activeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, nodes, edges, lastEditedBy: "user" }),
      });
      if (res.ok) {
        toast.success("Mindmap saved");
        setDirty(false);
        setPast([]);
        setFuture([]);
        await loadMindmaps();
      } else {
        toast.error("Save failed");
      }
    } finally {
      setSaving(false);
    }
  }, [activeId, name, nodes, edges, loadMindmaps]);

  const renameActive = useCallback(async (newName: string) => {
    setName(newName);
    if (!activeId) return;
    // Defer save of name to explicit Save button (don't auto-save)
    setDirty(true);
  }, [activeId]);

  // --- Agentic edit (chat with dashboard agent) ---
  const sendAgentMessage = useCallback(async () => {
    if (!chatInput.trim() || !activeId) return;
    const userText = chatInput.trim();
    setChatHistory((h) => [...h, { role: "user", text: userText }]);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await fetch("/api/dashboard/deep-dive?action=agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `I'm working on my mindmap "${name}" (id: ${activeId}). ${userText}`,
          mindmapContext: { id: activeId, name, nodes, edges },
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setChatHistory((h) => [...h, { role: "assistant", text: `Error: ${j.error ?? "agent failed"}` }]);
        return;
      }
      setChatHistory((h) => [...h, { role: "assistant", text: j.reply }]);

      // Look for proposed mindmap edits in the tool calls
      if (Array.isArray(j.toolCalls)) {
        for (const tc of j.toolCalls) {
          if (tc.name === "propose_mindmap_edit" && tc.result) {
            try {
              const parsed = JSON.parse(tc.result);
              if (parsed?.proposed) {
                setPendingProposal({
                  mindmapId: parsed.mindmapId,
                  mindmapName: parsed.mindmapName,
                  nodes: parsed.proposed.nodes,
                  edges: parsed.proposed.edges,
                  summary: parsed.summary ?? "Agent proposed an edit",
                  source: tc.result,
                });
              }
            } catch { /* not JSON, ignore */ }
          }
        }
      }
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, activeId, name, nodes, edges]);

  const applyProposal = useCallback(() => {
    if (!pendingProposal) return;
    snapshot();
    setNodes(pendingProposal.nodes);
    setEdges(pendingProposal.edges);
    setDirty(true);
    setPendingProposal(null);
    toast.success("Proposal applied — click Save to commit");
  }, [pendingProposal, snapshot]);

  const rejectProposal = useCallback(() => {
    setPendingProposal(null);
    toast.info("Proposal discarded");
  }, []);

  const defaultEdgeOptions = useMemo(() => ({
    animated: false,
    style: { stroke: "var(--border)", strokeWidth: 1.5 },
  }), []);

  return (
    <div className="bg-card border border-border rounded-2xl anim-fade-up">
      <div className="px-5 pt-5 pb-3">
        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
          <Network className="w-4 h-4 text-primary" /> Mindmaps
        </h2>
        <p className="text-xs text-muted-foreground mt-1.5">
          Sketch your accounts and plans as a map. Edit by hand, or ask the assistant to propose changes — nothing is saved until you press Save.
        </p>
      </div>
      <div className="px-5 pb-5 space-y-4">
        {/* Mindmap selector */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={activeId ?? ""}
            onChange={(e) => e.target.value && openMindmap(e.target.value)}
            className="bg-background border border-input rounded-xl px-3 py-2 text-xs text-foreground min-w-[200px] focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="">{loadingList ? "Loading…" : "Select a mindmap…"}</option>
            {mindmaps.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button
            onClick={createBlank}
            className="press h-9 px-3 rounded-xl border border-input text-xs font-medium text-foreground hover:bg-accent/50 transition-colors flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>

        {activeId ? (
          <>
            {/* Name + Save + Undo/Redo */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground block mb-1">Name</label>
                <input
                  value={name}
                  onChange={(e) => renameActive(e.target.value)}
                  className="w-full h-9 rounded-xl border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
              <button
                onClick={undo} disabled={past.length === 0}
                className="press h-9 w-9 rounded-xl border border-input flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40"
                title="Undo"
              >
                <Undo className="w-4 h-4" />
              </button>
              <button
                onClick={redo} disabled={future.length === 0}
                className="press h-9 w-9 rounded-xl border border-input flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40"
                title="Redo"
              >
                <Redo className="w-4 h-4" />
              </button>
              <button
                onClick={save} disabled={!dirty || saving}
                className="press h-9 px-4 rounded-xl bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 disabled:opacity-40 hover:opacity-95 transition-opacity"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {dirty ? "Save changes" : "Saved"}
              </button>
            </div>

            {/* Pending agent proposal */}
            {pendingProposal && (
              <div className="border border-amber-400/50 bg-amber-500/10 rounded-xl p-3.5 space-y-2 anim-pop-in">
                <p className="text-xs text-amber-600 dark:text-amber-400 font-semibold">Assistant proposed an edit</p>
                <p className="text-xs text-foreground/80">{pendingProposal.summary}</p>
                <p className="text-xs text-muted-foreground">
                  {pendingProposal.nodes.length} nodes · {pendingProposal.edges.length} edges
                </p>
                <div className="flex gap-2">
                  <button onClick={applyProposal} className="press h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 transition-opacity">
                    Apply (then Save)
                  </button>
                  <button onClick={rejectProposal} className="press h-8 px-3 rounded-lg border border-input text-xs font-medium text-foreground hover:bg-accent/50 transition-colors">
                    Discard
                  </button>
                </div>
              </div>
            )}

            {/* React Flow canvas */}
            <div className="border border-border rounded-xl h-[400px] bg-background relative overflow-hidden">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                defaultEdgeOptions={defaultEdgeOptions}
                onNodeDoubleClick={(_, node) => startEditNode(node)}
                fitView
                colorMode="system"
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} color="var(--border)" gap={20} />
                <Controls />
                <MiniMap
                  nodeColor="var(--primary)"
                  maskColor="var(--muted)"
                />
              </ReactFlow>
            </div>

            {/* Form-edit panel */}
            <div className="border border-border rounded-xl p-3.5 bg-muted/30 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-medium">
                  Quick edit {formIsCreating || editingNode ? (editingNode ? "(editing node)" : "(new node)") : ""}
                </p>
                <button onClick={startAddNode} className="press h-7 px-2.5 rounded-lg border border-input text-xs font-medium text-foreground hover:bg-accent/50 transition-colors flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Add node
                </button>
              </div>
              {(formIsCreating || editingNode) && (
                <div className="flex gap-2 items-end anim-fade-up">
                  <div className="flex-1">
                    <input
                      value={formLabel}
                      onChange={(e) => setFormLabel(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") submitForm(); }}
                      placeholder="e.g. SBI, IPO plan, Food budget…"
                      className="w-full h-9 rounded-xl border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                      autoFocus
                    />
                  </div>
                  <button onClick={submitForm} className="press h-9 px-3.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 transition-opacity">
                    {editingNode ? "Update" : "Add"}
                  </button>
                  <button onClick={() => { setEditingNode(null); setFormIsCreating(false); }} className="press h-9 w-9 rounded-xl border border-input flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground/70">
                Double-click a node to rename it. Drag between handles to connect.
              </p>
            </div>

            {/* Agentic edit chat */}
            <div className="border border-border rounded-xl p-3.5 bg-muted/30 space-y-2">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-primary" />
                <p className="text-xs text-foreground font-medium">Edit with the assistant</p>
              </div>
              <p className="text-[11px] text-muted-foreground/70">
                Describe the change you want — you&apos;ll get a proposal to review before anything changes.
              </p>
              <div className="border border-border rounded-xl max-h-[180px] overflow-y-auto p-2.5 space-y-1.5 text-xs bg-background">
                {chatHistory.length === 0 && (
                  <p className="text-muted-foreground/70 italic">Try: &quot;add nodes for my top 3 expense categories and link them to root&quot;</p>
                )}
                {chatHistory.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "text-foreground text-right" : "text-muted-foreground"}>
                    <span className="font-medium opacity-60">{m.role === "user" ? "you: " : "assistant: "}</span>
                    {m.text}
                  </div>
                ))}
                {chatLoading && (
                  <p className="text-muted-foreground italic flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" /> thinking…
                  </p>
                )}
              </div>
              <div className="flex gap-2 items-end">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask for a change to this mindmap…"
                  className="flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/40 min-h-[44px] max-h-[80px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendAgentMessage();
                    }
                  }}
                />
                <button onClick={sendAgentMessage} disabled={chatLoading || !chatInput.trim()} className="press h-10 px-4 rounded-xl bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40 hover:opacity-95 transition-opacity">
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-10 text-xs text-muted-foreground">
            <Network className="w-8 h-8 mx-auto mb-2 opacity-40" />
            Select a mindmap above, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}
