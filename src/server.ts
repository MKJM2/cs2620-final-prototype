// src/server.ts
import { Server } from "socket.io";
import { TextOperation, OperationComponent } from "./ot";
import type {
  ClientPushMsg,
  ClientPullMsg,
  ServerAckMsg,
  ServerUpdateMsg,
  ServerHistoryMsg,
  ServerInitialStateMsg,
} from "./types"; // Adjust path if needed

console.log("Starting OT Server...");

// --- Server State ---
let documentState = `# Collaborative Markdown Editor\n\nStart editing!`;
let currentRevision = 0;
// History stores the operations that *have been applied* to reach the current state.
// history[i] transforms revision i to revision i+1.
const operationHistory: TextOperation[] = [];

// --- Socket.IO Server Setup ---
const io = new Server({
  cors: {
    origin: "*", // Allow all origins for simplicity in prototype
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // 1. Send initial state to the newly connected client
  const initialStateMsg: ServerInitialStateMsg = {
    doc: documentState,
    revision: currentRevision,
  };
  socket.emit("initial_state", initialStateMsg);
  console.log(`Sent initial state (rev ${currentRevision}) to ${socket.id}`);

  // 2. Handle client pushing changes ('push')
  socket.on("push", (msg: ClientPushMsg) => {
    console.log(
      `Received push from ${socket.id} based on their rev ${msg.revision}`,
    );

    try {
      let clientOp = TextOperation.fromJSON(msg.op);
      const clientRevision = msg.revision;

      if (
        clientRevision < 0 ||
        clientRevision > currentRevision
      ) {
        console.error(
          `Invalid revision ${clientRevision} from ${socket.id}. Server revision is ${currentRevision}.`,
        );
        // Ideally, force client to re-sync here. For now, just ignore.
        return;
      }

      // Transform the client's operation against concurrent operations
      // that happened on the server since the client's revision.
      const concurrentOps = operationHistory.slice(clientRevision);
      let transformedClientOp = clientOp;

      for (const historicalOp of concurrentOps) {
        if (transformedClientOp.baseLength !== historicalOp.baseLength) {
             console.error(`History Inconsistency: Op ${transformedClientOp.toString()} (base ${transformedClientOp.baseLength}) cannot be transformed against historical op ${historicalOp.toString()} (base ${historicalOp.baseLength}) at revision ${clientRevision + concurrentOps.indexOf(historicalOp)}`);
             // This indicates a server-side bug or corrupted history.
             // A robust system might try recovery or halt. For prototype, log and proceed cautiously.
             // We might skip transformation if lengths mismatch, but that breaks OT guarantees.
             // Let's throw to indicate the critical error.
             throw new Error("Server history inconsistency detected during transform.");
        }
        [transformedClientOp] = TextOperation.transform(
          transformedClientOp,
          historicalOp,
        );
      }

      // Apply the transformed operation to the document state
      console.log(
        `Applying transformed op from ${socket.id}: ${transformedClientOp.toString()}`,
      );
      documentState = transformedClientOp.apply(documentState);
      currentRevision++;

      // Add the *transformed* operation to history
      operationHistory.push(transformedClientOp);

      // Send ACK to the original client
      const ackMsg: ServerAckMsg = { revision: currentRevision };
      socket.emit("ack", ackMsg);
      console.log(`Sent ack (new rev ${currentRevision}) to ${socket.id}`);

      // Broadcast the *transformed* operation to other clients
      const updateMsg: ServerUpdateMsg = {
        revision: currentRevision, // The revision *after* applying the op
        op: transformedClientOp.toJSON(),
      };
      socket.broadcast.emit("update", updateMsg);
      console.log(
        `Broadcast update (rev ${currentRevision}) to other clients`,
      );
    } catch (error) {
      console.error(
        `Error processing push from ${socket.id}:`,
        error,
        "Message:",
        msg,
      );
      // Inform client of failure? Maybe send an error message.
      socket.emit("error", { message: "Failed to process operation." });
    }
  });

  // 3. Handle client pulling changes ('pull')
  socket.on("pull", (msg: ClientPullMsg) => {
    console.log(
      `Received pull from ${socket.id} requesting ops since rev ${msg.revision}`,
    );
    const clientRevision = msg.revision;

    if (
      clientRevision < 0 ||
      clientRevision > currentRevision
    ) {
      console.error(
        `Invalid revision ${clientRevision} in pull request from ${socket.id}. Server revision is ${currentRevision}.`,
      );
      // Send current state instead? Or an error? Let's send history from 0.
       const historyToSend = operationHistory.map(op => op.toJSON());
       const historyMsg: ServerHistoryMsg = {
           startRevision: 1, // Ops start transforming from rev 0 to 1
           ops: historyToSend,
           currentRevision: currentRevision,
       };
       socket.emit("history", historyMsg);
       console.warn(`Sent full history due to invalid pull revision from ${socket.id}`);
      return;
    }

    const opsToSend = operationHistory
        .slice(clientRevision)
        .map((op) => op.toJSON());

    const historyMsg: ServerHistoryMsg = {
        startRevision: clientRevision + 1, // First op transforms clientRevision -> clientRevision + 1
        ops: opsToSend,
        currentRevision: currentRevision,
    };
    socket.emit("history", historyMsg);
    console.log(`Sent ${opsToSend.length} ops (rev ${clientRevision + 1} to ${currentRevision}) to ${socket.id}`);

  });

  // 4. Handle disconnect
  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
io.listen(parseInt(PORT as string, 10));
console.log(`Socket.IO server listening on port ${PORT}`);
