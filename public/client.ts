// public/client.ts
import { io, Socket } from "socket.io-client";
import { TextOperation } from "../src/ot"; // Adjust path
import type {
  ServerInitialStateMsg,
  ServerAckMsg,
  ServerUpdateMsg,
  ServerHistoryMsg,
  ClientPushMsg,
  ClientPullMsg,
} from "../src/types"; // Adjust path

// Make ace available globally if needed, or import types if using modules
declare var ace: AceAjax.Ace | null;

// Declare Alpine as globally available (since it's loaded from CDN)
declare var Alpine: any;

/**
 * Helper: Convert a coordinate (row, column) into a linear index
 * based on an array of lines.
 */
function positionToIndex(lines: string[], pos: { row: number; column: number }) {
  let index = 0;
  for (let i = 0; i < pos.row; i++) {
    index += lines[i].length + 1; // +1 for newline separator
  }
  index += pos.column;
  return index;
}

/**
 * Convert an Ace delta event into a TextOperation.
 * We assume that `this.virtualDoc` (a property of the client)
 * holds the document text before the change.
 */
function convertAceDeltaToOp(this: any, delta: AceAjax.Delta): TextOperation {
  // Use virtualDoc (the last synced plus buffered changes) as base
  const text: string = this.virtualDoc;
  const lines: string[] = text.split("\n");

  const index = positionToIndex(lines, delta.start);
  const op = new TextOperation();

  // Our op should “retain” everything up to the change, unless retain is 0
  if (index != 0) {
    op.retain(index);
  }

  if (delta.action === "insert") {
    const text = delta.lines.join("\n");
    op.insert(text);
    // Final retain: remaining length from the base.
    op.retain(this.virtualDoc.length - index);
  } else if (delta.action === "remove") {
    // For removal, the delta object has an 'end' property.
    // Compute the deletion length based on the removed text.
    const removedText = delta.lines.join("\n");
    op.delete(removedText.length);
    op.retain(this.virtualDoc.length - (index + removedText.length));
  }

  return op;
}


// Alpine.js data function
function editorApp() {
  return {
    // --- State ---
    editor: null as AceAjax.Editor | null, // Ace editor instance
    socket: null as Socket | null,
    serverUrl: "http://localhost:3000", // Default server URL
    statusText: "Connecting...",
    isConnected: false,
    mode: "Automatic", // 'Manual' or 'Automatic'
    log: [] as string[],

    // OT State
    /** Document content corresponding to serverRevision */
    syncedDoc: "",
    /** Tracks the local document state by applying all local (buffered) changes
     * on top of syncedDoc. Useful for converting Ace deltas, so we don’t need a diff.
     */
    virtualDoc: "",
    /** Last known revision acknowledged by the server */
    serverRevision: -1,
    /** Revision of the local editor content (can be ahead of serverRevision if offline changes exist) */
    localRevision: -1, // Not strictly needed in pure manual mode, but useful conceptually
    /** Current state of the client relative to the server */
    state: "initializing" as
      | "initializing"
      | "synchronized" // Local == Server @ serverRevision
      | "dirty" // Local changes exist, not pushed
      | "awaitingPush" // Push sent, waiting for ACK
      | "awaitingPull", // Pull sent, waiting for History
    /** Operation sent to server, awaiting ACK */
    outstandingOp: null as TextOperation | null,
    /** Local changes made since last successful push/pull, not yet pushed */
    bufferedOp: null as TextOperation | null,
    updateQueue: [] as ServerUpdateMsg[],
    ignoreNextEditorChange: false, // Flag to prevent feedback loops when setting editor value programmatically

    // Automatic Mode State management
    autoPushIntervalId: null as number | null, // Stores the interval ID
    autoPushIntervalMs: 200, // Interval in milliseconds

    // --- Computed Properties / Helpers ---
    canPush(): boolean {
      return (
        this.isConnected &&
        this.mode === "Manual" &&
        this.state !== "awaitingPush" &&
        this.state !== "awaitingPull" &&
        this.bufferedOp !== null  // We only want to push if there are outstanding local changes
      );
    },
    canPull(): boolean {
      return (
        this.isConnected &&
        this.state !== "awaitingPush" &&
        this.state !== "awaitingPull"
      );
    },

    // --- Methods ---
    addLog(message: string) {
      const timestamp = new Date().toLocaleTimeString();
      console.debug(message);
      this.log.unshift(`[${timestamp}] ${message}`);
      if (this.log.length > 100) {
        // Keep log size manageable
        this.log.pop();
      }
    },


    withNoLocalUpdate(task: (...args: any[]) => any): (...args: any[]) => Promise<any> {
      return async (...args: any[]): Promise<any> => {
        this.ignoreNextEditorChange = true;
        try {
          return await task.apply(this, args);
        } finally {
          this.ignoreNextEditorChange = false;
        }
      };
    },

    /** Sets editor content without triggering the 'change' listener */
    setEditorValue(value: string) {
      if (!this.editor) return;
      // setValue is implemented within Ace.js as an remove + insert operation.
      // The first operation will trigger a local update which will be programmatically ignored
      // in our handleLocalDelta handler, since this.ignoreNextEditorChange = true. However,
      // the subsequent insert operation will not be programatiicaly blocked 
      // (this.ignoreNextEditorChange is reset to false by the handleLocalDelta handler once its
      // execution is done), this triggeres a local delta which messes up our logic. We 
      // need a way to block both updates
      this.withNoLocalUpdate(() => {
        // TODO: In the future, once we've verified robustness of the OT
        // implementation, we might want to consider storing and then restoring
        // the cursor position here.
        // const cursorPos = this.editor.getCursorPosition();
        this.editor!.setValue(value, -1);
      })();

      // Reset OT state on programmatic changes:
      // this.syncedDoc = value;
      this.virtualDoc = value;
    },

    /** Process a local Ace delta event by converting it to a TextOperation,
     * composing it with any unpushed buffered changes, and updating the local
     * virtual document.
     */
    handleLocalDelta(delta: AceAjax.Delta) {
      console.log("Delta:", delta.start, delta.end, delta.action, delta.lines);
      if (this.ignoreNextEditorChange) {
        console.log("Ignoring...")
        return;
      }

      // Convert the delta to a small operation.
      const op: TextOperation = convertAceDeltaToOp.call(this, delta);
      console.log("Handle local change:", op);
      // Compose with any existing buffered operation.
      if (this.bufferedOp) {
        this.bufferedOp = this.bufferedOp.compose(op);
      } else {
        this.bufferedOp = op;
      }
      // Update our virtual document.
      try {
        this.virtualDoc = op.apply(this.virtualDoc);
      } catch (e: any) {
        this.addLog(
          `Error applying local op to virtualDoc: ${e.message}. Resetting OT state.`
        );
        // In a real-world system you might force a resync here.
        this.virtualDoc = this.editor?.getValue() || "";
        this.bufferedOp = null;
      }
      // Mark that we have unsent local changes. Note that if we pushed local changes before,
      // and are yet to receive the ACK back from the server, we will be in the "awaitingPush"
      // state, and we shouldn't overwrite it here!
      if (this.state !== "initializing") {
        if (this.editor!.getValue() !== this.syncedDoc && this.state !== 'awaitingPush') {
          this.state = "dirty";
          console.log("Editor changed, state -> dirty");
        } else if (this.editor!.getValue() === this.syncedDoc && this.state === 'dirty') {
          // Changed back to synced state manually
          this.state = 'synchronized';
          console.log("Editor changed back to synced state");
        }
      }
    },

    /**
     * Processes a single server update message. Assumes the client is NOT
     * in the awaitingPush state when this is called directly.
     * Transforms the op against bufferedOp, applies it to syncedDoc and editor.
     */
    processServerUpdate(msg: ServerUpdateMsg) {
      this.addLog(
        `Processing server update for revision ${msg.revision}. Op: ${TextOperation.fromJSON(msg.op).toString()}`,
      );

      if (msg.revision !== this.serverRevision + 1) {
        this.addLog(
          `Error: Received out-of-order update (expected ${this.serverRevision + 1}, got ${msg.revision}). Requesting full sync.`,
        );
        this.pullChanges(); // Request history to re-sync
        return;
      }

      let serverOp: TextOperation = TextOperation.fromJSON(msg.op);

      // --- CRITICAL CHANGE: Transformation logic simplified ---
      // We only transform against the BUFFERED operation now.
      // The transformation against outstandingOp is removed because this function
      // is only called when state is NOT awaitingPush (or when processing the queue AFTER ack).

      // 1. Transform against buffered operation (local changes made *after* the last push/ack)
      if (this.bufferedOp) {
        // Important: Ensure base lengths match for transformation
        // The serverOp's baseLength should correspond to the state *after* any outstandingOp
        // was applied, which is the base for our bufferedOp.
        // Let's add a check, although conceptually they should align if server logic is correct.
        const expectedBufferedBaseLength = this.syncedDoc.length; // Base for bufferedOp is the synced state
        if (this.bufferedOp.baseLength !== expectedBufferedBaseLength) {
          this.addLog(`CRITICAL ERROR: Base length mismatch for bufferedOp during update transform. Expected ${expectedBufferedBaseLength}, got ${this.bufferedOp.baseLength}. Forcing pull.`);
          this.pullChanges();
          return;
        }
        // Also check serverOp base length against syncedDoc
        if (serverOp.baseLength !== this.syncedDoc.length) {
          this.addLog(`CRITICAL ERROR: Base length mismatch for serverOp during update transform. Expected ${this.syncedDoc.length}, got ${serverOp.baseLength}. Forcing pull.`);
          this.pullChanges();
          return;
        }

        try {
          // We transform the server op against the buffered local changes.
          // [serverOp', bufferedOp'] = transform(serverOp, bufferedOp)
          const [serverOpPrime, bufferedOpPrime] = TextOperation.transform(
            serverOp,
            this.bufferedOp,
          );
          serverOp = serverOpPrime; // Use the transformed server op
          this.bufferedOp = bufferedOpPrime; // Update the buffered op
          this.addLog(`Transformed server op against buffered op.`);
        } catch (e: any) {
          this.addLog(
            `CRITICAL ERROR during transform against buffered op: ${e.message}. Forcing pull.`,
          );
          this.pullChanges();
          return;
        }
      }

      // 2. Apply the (potentially transformed) serverOp to our syncedDoc baseline
      try {
        this.syncedDoc = serverOp.apply(this.syncedDoc);
      } catch (e: any) {
        this.addLog(
          `CRITICAL ERROR applying server op to syncedDoc: ${e.message}. Forcing pull.`,
        );
        this.pullChanges();
        return;
      }

      // 3. Apply the same transformed server operation to the editor
      // The editor content should reflect syncedDoc + bufferedOp. Applying serverOp
      // (which was transformed against bufferedOp) should bring the editor state
      // to syncedDoc' + bufferedOp'.
      try {
        const currentEditorContent = this.editor!.getValue();
        // We apply the *same* serverOp that was applied to syncedDoc.
        // Its transformation against bufferedOp ensures it correctly modifies
        // the editor state which includes those buffered changes.
        const newEditorContent = serverOp.apply(currentEditorContent);
        this.setEditorValue(newEditorContent); // Uses withNoLocalUpdate internally
        this.addLog(`Applied transformed server op (${serverOp.toString()}) to editor.`);
        // Update virtualDoc AFTER applying to editor to keep it consistent
        this.virtualDoc = this.editor!.getValue();
      } catch (e: any) {
        this.addLog(
          `CRITICAL ERROR applying transformed server op to editor: ${e.message}. Forcing pull.`,
        );
        this.pullChanges();
        return;
      }

      // 4. Update server revision
      this.serverRevision = msg.revision;
      // Local revision stays aligned in manual mode after an update is integrated.
      // If we had buffered ops, they were transformed, but the base revision is now updated.
      this.localRevision = msg.revision;

      // 5. Re-evaluate state: If bufferedOp still exists (or became non-noop after transform), we are dirty.
      if (this.bufferedOp && !this.bufferedOp.isNoop()) {
        this.state = "dirty";
        // No log needed here, state is naturally dirty
      } else {
        // If buffer is gone or became no-op, clear it and check sync state
        this.bufferedOp = null;
        if (this.editor?.getValue() === this.syncedDoc) {
          this.state = 'synchronized';
        } else {
          // This case might indicate an issue, but let's assume editor value is the source of truth for "dirty"
          this.state = 'dirty';
          this.addLog("Warning: Editor content differs from syncedDoc after update, but buffer is empty. State -> dirty.");
        }
      }
    }, // End of processServerUpdate

    /** Processes any queued update messages */
    applyQueuedUpdates() {
      if (this.updateQueue.length === 0) {
        return;
      }
      this.addLog(`Processing ${this.updateQueue.length} queued update(s)...`);
      // Process updates FIFO
      while (this.updateQueue.length > 0) {
        const msg = this.updateQueue.shift();
        if (msg) {
          // Call the refactored processing logic
          this.processServerUpdate(msg);
          // If processServerUpdate triggered a pull, stop processing queue
          if (this.state === 'awaitingPull' || this.state === 'initializing') {
            this.addLog("Pull triggered during queue processing. Clearing remaining queue.");
            this.updateQueue = [];
            break;
          }
        }
      }
      this.addLog("Finished processing queued updates.");
    },



    /** Initialize Ace Editor */
    initEditor() {
      this.editor = ace!.edit("editor");  // Ace will be loaded via CDN, and not bundled
      this.editor.setTheme("ace/theme/monokai");
      this.editor.session.setMode("ace/mode/markdown");
      this.editor.setReadOnly(true); // Read-only until connected and state received

      this.editor.session.on("change", (delta: AceAjax.Delta) => {
        this.handleLocalDelta(delta);
        /*
        if (this.ignoreNextEditorChange) {
          // console.log("Ignoring programmatic editor change");
          // Reset flag immediately if possible, though timeout handles async cases
          // this.ignoreNextEditorChange = false;
          return;
        }
        if (this.state !== "initializing" && this.mode === 'Manual') {
            // In manual mode, simply mark as dirty. The diff happens on push.
            if (this.editor.getValue() !== this.syncedDoc && this.state !== 'awaitingPush') {
                 this.state = "dirty";
                 // console.log("Editor changed, state -> dirty");
            } else if (this.editor.getValue() === this.syncedDoc && this.state === 'dirty') {
                // Changed back to synced state manually
                this.state = 'synchronized';
                // console.log("Editor changed back to synced state");
            }
        }
        // Automatic mode would handle incremental OT composition here
        */
      });
    },

    /** Initialize Socket.IO Connection */
    initSocketIO() {
      console.log("Initializing websocket connection...");
      // this.socket = io(this.serverUrl);
      this.socket = io({ transports: ['websocket'], upgrade: false });

      this.socket.on("connect", () => {
        this.isConnected = true;
        this.statusText = "Connected";
        this.addLog(`Connected to server: ${this.serverUrl}`);
        // Client doesn't request initial state; server sends it automatically
      });

      this.socket.on("disconnect", (reason) => {
        this.isConnected = false;
        this.statusText = `Disconnected: ${reason}`;
        this.addLog(`Disconnected from server: ${reason}`);
        this.state = "initializing"; // Reset state
        this.serverRevision = -1;
        this.localRevision = -1;
        this.outstandingOp = null;
        this.editor?.setReadOnly(true);
        this.stopAutoPushTimer(); // Stop auto-push on disconnect
      });

      this.socket.on("connect_error", (err) => {
        this.isConnected = false;
        this.statusText = `Connection Error`;
        this.addLog(`Connection error: ${err.message}`);
        this.state = "initializing";
        this.serverRevision = -1;
        this.localRevision = -1;
        this.outstandingOp = null;
        this.editor?.setReadOnly(true);
        this.stopAutoPushTimer();
      });

      // --- Server Message Handlers ---

      this.socket.on("initial_state", (msg: ServerInitialStateMsg) => {
        this.addLog(
          `Received initial state. Revision: ${msg.revision}. Doc length: ${msg.doc.length}`,
        );
        this.syncedDoc = msg.doc;
        this.virtualDoc = msg.doc;
        this.serverRevision = msg.revision;
        this.localRevision = msg.revision; // Start local revision aligned with server
        this.setEditorValue(msg.doc);
        this.editor?.setReadOnly(false);
        this.state = "synchronized";
        this.outstandingOp = null;
        this.bufferedOp = null;
        this.startAutoPushTimer();
      });

      this.socket.on("ack", (msg: ServerAckMsg) => {
        if (this.state !== "awaitingPush") {
          this.addLog(`Warning: Received unexpected ACK for revision ${msg.revision}. Current state: ${this.state}`);
          return; // Ignore unexpected ACKs
        }
        if (!this.outstandingOp) {
          this.addLog(`Warning: Received ACK for revision ${msg.revision} but no outstanding operation was recorded.`);
          this.state = 'synchronized'; // Try to recover state
          this.applyQueuedUpdates(); // Process queue if any
          return;
        }

        this.addLog(`Push acknowledged by server. New revision: ${msg.revision}`);

        // The document state *before* this ACK corresponds to the baseLength of outstandingOp.
        // The document state *after* this ACK corresponds to the targetLength of outstandingOp.

        // Apply the acknowledged outstanding op to the syncedDoc baseline
        try {
          this.syncedDoc = this.outstandingOp.apply(this.syncedDoc);
        } catch (e: any) {
          this.addLog(`CRITICAL ERROR applying outstanding op to syncedDoc on ACK: ${e.message}. Forcing pull.`);
          // Clear outstanding op to prevent retries, state will be handled by pull
          this.outstandingOp = null;
          this.pullChanges();
          return; // Stop processing ACK
        }


        this.serverRevision = msg.revision;
        this.localRevision = msg.revision; // Align local revision after successful push
        this.outstandingOp = null;

        // State transition depends on whether there's a bufferedOp
        if (this.bufferedOp && !this.bufferedOp.isNoop()) {
          this.state = "dirty";
          this.addLog(
            "Local changes were buffered while push was in flight. State -> dirty.",
          );
        } else {
          this.bufferedOp = null; // Ensure empty/noop buffer is cleared
          // Check actual content match before declaring synchronized
          if (this.editor?.getValue() === this.syncedDoc) {
            this.state = "synchronized";
          } else {
            // If content differs but buffer is empty, something might be off.
            // Treat as dirty to allow user/auto push to potentially fix it.
            this.state = "dirty";
            this.addLog("Warning: Editor content differs from syncedDoc after ACK, but buffer is empty. State -> dirty.");
            // This might happen if setEditorValue caused inconsistencies previously.
            // A pull might be warranted if this state persists.
          }
        }

        // --- CRITICALLY: Process the queue ---
        this.applyQueuedUpdates();
        // The state might change again inside applyQueuedUpdates
      });

      this.socket.on("update", (msg: ServerUpdateMsg) => {
        this.addLog(
          `Received server update for revision ${msg.revision}. Op: ${TextOperation.fromJSON(msg.op).toString()}`,
        );

        if (this.state === "awaitingPush") {
          this.addLog(
            `Queueing server update for rev ${msg.revision} while awaiting ACK.`,
          );
          this.updateQueue.push(msg);
          return; // Don't process now
        }

        this.processServerUpdate(msg);
      });

      this.socket.on("history", (msg: ServerHistoryMsg) => {
        if (this.state !== 'awaitingPull') {
          this.addLog(`Warning: Received unexpected history. State: ${this.state}`);
          // Might happen if pull was triggered by an error condition. Allow processing.
          // return;
        }
        this.addLog(
          `Received history: ${msg.ops.length} ops (rev ${msg.startRevision} to ${msg.currentRevision})`,
        );

        // Clear the update queue, as history should have brough client fully up-to-date.
        this.addLog("Clearing any pending update queue due to received history.");
        this.updateQueue = [];

        // This logic assumes the pull was requested because we were out of sync.
        // We need to apply these historical operations carefully.
        // The safest approach is often to just reset the client state to the latest full state,
        // but let's try applying the history for robustness.

        if (msg.startRevision !== this.serverRevision + 1) {
          this.addLog(`Warning: History start revision ${msg.startRevision} doesn't match expected ${this.serverRevision + 1}. Resetting might be needed.`);
          // Attempt to apply anyway, but this indicates potential issues.
        }

        let currentEditorContent = this.editor!.getValue();

        try {
          for (const opJson of msg.ops) {
            let serverOp = TextOperation.fromJSON(opJson);
            const expectedRevision = this.serverRevision + 1; // Revision this op transforms *from*

            // Transform against outstanding op first
            if (this.outstandingOp) {
              if (this.outstandingOp.baseLength !== serverOp.baseLength) {
                throw new Error(`History transform (outstanding) base length mismatch at rev ${expectedRevision}. Op: ${serverOp.toString()}, Outstanding: ${this.outstandingOp.toString()}`);
              }
              [serverOp, this.outstandingOp] = TextOperation.transform(serverOp, this.outstandingOp);
            }

            // Apply transformed op to syncedDoc baseline
            this.syncedDoc = serverOp.apply(this.syncedDoc);

            // Apply transformed op to editor content (considering dirty state implicitly)
            // Similar logic as in 'update', but repeated for each historical op.
            let editorOpToApply = serverOp;
            if ((this.state === 'dirty' || this.editor?.getValue() !== this.syncedDoc) && this.bufferedOp) { // Check actual content diff
              [editorOpToApply, this.bufferedOp] = TextOperation.transform(serverOp, this.bufferedOp);
            }

            currentEditorContent = editorOpToApply.apply(currentEditorContent);
            this.serverRevision++; // Increment revision for each applied op
          }

          // After applying all history, set the editor value
          this.setEditorValue(currentEditorContent);
          this.serverRevision = msg.currentRevision; // Ensure final revision matches server
          this.localRevision = msg.currentRevision; // Align local revision

          this.addLog(`Applied history. Now at server revision ${this.serverRevision}.`);

          // Final state check
          if (this.outstandingOp) {
            this.state = 'awaitingPush'; // Still waiting for original push ACK
          } else if (this.editor?.getValue() !== this.syncedDoc) {
            this.state = 'dirty';
          } else {
            this.state = 'synchronized';
          }

        } catch (error: any) {
          this.addLog(`CRITICAL ERROR applying history: ${error.message}. Requesting full reset.`);
          this.state = 'initializing';
          this.editor?.setReadOnly(true);
          this.setEditorValue("Error applying history. Reconnecting...");
          // Force reconnect to get fresh initial state
          this.socket?.disconnect().connect();
        } finally {
          if (this.state === 'awaitingPull') {
            // If we were awaiting pull, transition based on outcome
            if (!this.outstandingOp) {
              if (this.editor?.getValue() === this.syncedDoc) this.state = 'synchronized';
              else this.state = 'dirty';
            } else if (this.outstandingOp) {
              this.state = 'awaitingPush';
            }
          }
          // Restart timer if we are in Automatic mode and connected
          this.startAutoPushTimer(); // Safe to call even if already running or not in auto mode
        }
      });

      this.socket.on("error", (msg: { message: string }) => {
        this.addLog(`Server Error: ${msg.message}`);
        // Could indicate push failure, etc. May need recovery logic.
        if (this.state === 'awaitingPush') {
          this.addLog("Push likely failed on server. Resetting outstanding op.");
          this.outstandingOp = null;
          this.state = 'dirty'; // Assume local changes still exist
        }
      });
    },

    handleModeChange() {
      this.addLog(`Mode changed to ${this.mode}`);
      if (this.mode === "Automatic") {
        this.startAutoPushTimer();
        // Immediately attempt a push if there are pending changes
        this.autoPushTask();
      } else {
        this.stopAutoPushTimer();
      }
    },

    /** Start the automatic push timer */
    startAutoPushTimer() {
      if (this.autoPushIntervalId !== null) {
        // Timer already running
        return;
      }
      if (this.mode === "Automatic" && this.isConnected && this.state !== 'initializing') {
        this.addLog(
          `Starting automatic push timer (${this.autoPushIntervalMs}ms)`,
        );
        this.autoPushIntervalId = window.setInterval(
          this.autoPushTask.bind(this),
          this.autoPushIntervalMs,
        );
      }
    },

    /** Stop the automatic push timer */
    stopAutoPushTimer() {
      if (this.autoPushIntervalId !== null) {
        this.addLog("Stopping automatic push timer.");
        window.clearInterval(this.autoPushIntervalId);
        this.autoPushIntervalId = null;
      }
    },

    /** Task run periodically by the timer in Automatic mode */
    autoPushTask() {
      // Conditions for auto-push:
      // 1. Mode must be Automatic
      // 2. Must be connected
      // 3. Must have buffered changes (not null and not no-op)
      // 4. Must be in a state ready to send (synchronized or dirty)
      if (
        this.mode !== "Automatic" ||
        !this.isConnected ||
        !this.bufferedOp ||
        this.bufferedOp.isNoop() ||
        !(this.state === "synchronized" || this.state === "dirty")
      ) {
        console.debug("Auto-push conditions not met."); // Optional debug log
        return;
      }

      // --- Atomic Section Start ---
      // This block runs synchronously within the timer callback.
      // No other event handler (like handleLocalDelta) can interrupt it.
      this.addLog("Auto-push triggered.");
      const opToSend = this.bufferedOp;
      this.outstandingOp = opToSend;
      this.bufferedOp = null; // Clear buffer *after* copying
      this.state = "awaitingPush";
      // --- Atomic Section End ---

      // Initiate the asynchronous network request
      this.pushChangesInternal(opToSend);
    },

    /** Internal push logic used by both manual and automatic modes */
    pushChangesInternal(opToSend: TextOperation) {
      if (!this.socket) {  // Should not happen if isConnected is true
        console.error("Socket not initialized. Cannot push changes.");
        return;
      }

      this.addLog(
        `Pushing changes based on server revision ${this.serverRevision}. Op: ${opToSend.toString()}`,
      );

      const pushMsg: ClientPushMsg = {
        revision: this.serverRevision,
        op: opToSend.toJSON(),
      };
      this.socket.emit("push", pushMsg);
    },

    /** Push local changes to the server (Manual Mode Trigger) */
    pushChanges() {
      // This function is the *trigger* for manual pushes.
      // It relies on canPush for UI enablement.
      if (!this.canPush() || !this.socket || !this.bufferedOp) {
        this.addLog("Manual push conditions not met or no changes to push.");
        if (this.bufferedOp && this.bufferedOp.isNoop()) {
          this.bufferedOp = null; // Clear no-op buffer
          if (this.state === 'dirty') this.state = 'synchronized';
        }
        return;
      }

      // --- Atomic Section (Manual) ---
      const opToSend = this.bufferedOp;
      if (opToSend.isNoop()) {
        this.bufferedOp = null;
        this.addLog("No effective changes to push.");
        if (this.state === 'dirty') this.state = 'synchronized';
        return;
      }
      this.outstandingOp = opToSend;
      this.bufferedOp = null;
      this.state = "awaitingPush";
      // --- Atomic Section End (Manual) ---

      this.pushChangesInternal(opToSend);
    },

    /** Pull latest changes from the server */
    pullChanges() {
      if (!this.canPull() || !this.socket) return;

      this.addLog(`Pulling changes since server revision ${this.serverRevision}`);

      // Stop auto-pushes temporarily while pulling history
      const wasAuto = this.mode === 'Automatic';
      if (wasAuto) this.stopAutoPushTimer();

      this.state = "awaitingPull";
      const pullMsg: ClientPullMsg = {
        revision: this.serverRevision,
      };
      this.socket.emit("pull", pullMsg);

      // We need to restart the timer *after* the history is processed and state settles.
      // This is handled within the 'history' event handler's final state check.
      // We might need a flag or check the mode again in the history handler's finally block.
      // Let's modify the history handler slightly.
    },

    // --- Init ---
    init() {
      console.log("Initializing Alpine component...");
      this.initEditor();
      this.initSocketIO();
      this.addLog("Client initialized. Waiting for connection...");

      // Ensure timer is stopped initially
      this.stopAutoPushTimer();

      // Add cleanup for when the component is destroyed (e.g., page navigation)
      // Alpine doesn't have a built-in destroy hook easily accessible here,
      // but window unload is a decent proxy for cleanup.
      window.addEventListener('beforeunload', () => {
        this.stopAutoPushTimer();
        this.socket?.disconnect();
      });
    },
  };
}


// Register with AlpineJS AFTER Alpine is initialized
document.addEventListener('alpine:init', () => {
  console.log("Alpine initializing, registering editorApp component...");
  Alpine.data('editorApp', editorApp);
});
