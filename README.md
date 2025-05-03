# Collaborative Markdown Editor (OT Prototype)

This project implements a basic real-time collaborative Markdown editor using Operational Transformation (OT). It features a client-server architecture where text changes are synchronized between multiple users via WebSockets.

## Features

*   **Operational Transformation:** Core OT logic (`apply`, `invert`, `compose`, `transform`) for text manipulation.
*   **Client-Server Architecture:** Uses Socket.IO for WebSocket communication between a central server and multiple clients.
*   **Revision Tracking:** Server maintains a linear history of operations and document revisions.
*   **Manual Synchronization:** Clients currently use explicit "Push" and "Pull" actions to send and receive changes.
*   **Basic Editor UI:** Uses Ace Editor for text input and Alpine.js for simple UI state management.
*   **TypeScript:** Entire codebase (client and server) written in TypeScript.
*   **Testing:** Includes unit tests for the core OT logic using Vitest.

## Technology Stack

*   **Backend:** Bun, TypeScript, Socket.IO
*   **Frontend:** TypeScript, Ace Editor, Alpine.js, Socket.IO Client
*   **Testing:** Vitest
*   **Build:** Bun

## Project Structure

```
./
├── src/
│   ├── types.ts       # Shared TypeScript types for client/server messages
│   ├── ot.ts          # Core Operational Transformation logic (TextOperation class)
│   ├── server.ts      # Socket.IO server implementation
│   └── ot.test.ts     # Unit tests for ot.ts
├── public/
│   ├── style.css      # Basic styling for the editor page
│   ├── index.html     # Main HTML structure
│   ├── client.js      # Bundled JavaScript client code (output of build)
│   └── client.ts      # Client-side TypeScript logic (Ace integration, OT state machine, Socket.IO handling)
├── package.json     # Project dependencies and scripts
└── tsconfig.json    # TypeScript configuration
```

## Core Concepts

### Operational Transformation (`src/ot.ts`)

The foundation is the `TextOperation` class, which represents changes to a document. Operations consist of components:

*   `retain(n)`: Keep the next `n` characters.
*   `insert(str)`: Insert the string `str`.
*   `delete(n)`: Delete the next `n` characters.

Key methods include:

*   `apply(doc)`: Applies the operation to a document string.
*   `invert(doc)`: Computes the inverse operation.
*   `compose(otherOp)`: Combines two sequential operations into one.
*   `transform(op1, op2)`: Transforms two concurrent operations (`op1`, `op2`) against each other, producing `[op1', op2']` such that applying `op1` then `op2'` yields the same result as applying `op2` then `op1'`. This is crucial for ensuring eventual consistency.

### Client-Server Protocol (`src/types.ts`, `src/server.ts`, `public/client.ts`)

Communication relies on a defined set of messages:

*   **Client -> Server:**
    *   `ClientPushMsg`: Sends a client-generated operation (`op`) based on a known server `revision`.
    *   `ClientPullMsg`: Requests operations from the server since a specific `revision`.
*   **Server -> Client:**
    *   `ServerInitialStateMsg`: Sent on connection, providing the full document (`doc`) and current `revision`.
    *   `ServerAckMsg`: Acknowledges a successful `ClientPushMsg`, returning the new server `revision`.
    *   `ServerUpdateMsg`: Broadcasts an operation (`op`) applied on the server, tagged with its `revision`.
    *   `ServerHistoryMsg`: Sends a list of operations (`ops`) in response to a `ClientPullMsg`.

### Server State (`src/server.ts`)

The server maintains:

*   `documentState`: The current authoritative version of the document.
*   `currentRevision`: The revision number corresponding to `documentState`.
*   `operationHistory`: An array storing the `TextOperation` objects that transform revision `i` to `i+1`.

When receiving a `ClientPushMsg`, the server transforms the client's operation against any concurrent operations in `operationHistory` before applying it and broadcasting an `ServerUpdateMsg`.

### Client State (`public/client.ts`)

The client manages its state relative to the server:

*   `syncedDoc`: The document state corresponding to `serverRevision`.
*   `virtualDoc`: `syncedDoc` plus any local, unpushed changes (`bufferedOp`). Used as the base for generating new local operations.
*   `serverRevision`: The latest revision known to the client (updated via ACK, Update, History).
*   `state`: Tracks the client's synchronization status (`synchronized`, `dirty`, `awaitingPush`, `awaitingPull`).
*   `outstandingOp`: An operation sent to the server, awaiting acknowledgment (`ServerAckMsg`).
*   `bufferedOp`: Local changes made since the last sync, composed into a single operation, not yet pushed.

The client uses `transform` to integrate incoming `ServerUpdateMsg` operations with its local `outstandingOp` and `bufferedOp` to maintain consistency.

## Setup and Running

**Prerequisites:**

*   Bun installed (`curl -fsSL https://bun.sh/install | bash`)

**Installation:**

```bash
bun install
```

**Build Client:**

The client-side TypeScript needs to be bundled into JavaScript for the browser.

```bash
bun run build:client
```

**Running the Server:**

*   For development (with auto-reloading):
    ```bash
    bun run dev
    ```
*   For production start:
    ```bash
    bun start
    ```

The server will start, typically on `http://localhost:3000`.

**Accessing the Application:**

Open your web browser and navigate to `http://localhost:3000`. Open multiple tabs or browsers to simulate collaboration.

## Testing

Run the unit tests for the OT logic:

```bash
bun test
```

The tests in `src/ot.test.ts` verify the core properties and invariants of the `TextOperation` class methods (`apply`, `invert`, `compose`, `transform`).

## How It Works (Manual Mode)

1.  **Connect:** Client connects via WebSocket. Server sends `ServerInitialStateMsg`. Client loads the document and sets its state to `synchronized`.
2.  **Local Edit:** User types in the editor. The `change` event triggers `handleLocalDelta`, which converts the Ace delta into a `TextOperation` and composes it into `bufferedOp`. State becomes `dirty`. `virtualDoc` is updated.
3.  **Push:** User clicks "Push Changes".
    *   If `bufferedOp` exists, it's moved to `outstandingOp`.
    *   `bufferedOp` is cleared.
    *   State becomes `awaitingPush`.
    *   `ClientPushMsg` containing `outstandingOp` and `serverRevision` is sent.
4.  **Server Receives Push:**
    *   Server retrieves operations from `operationHistory` that occurred after the client's `revision`.
    *   Server transforms the incoming client operation against these historical operations using `TextOperation.transform`.
    *   The transformed operation is applied to the server's `documentState`.
    *   The transformed operation is added to `operationHistory`.
    *   `currentRevision` is incremented.
    *   `ServerAckMsg` is sent back to the originating client.
    *   `ServerUpdateMsg` containing the *transformed* operation is broadcast to all *other* clients.
5.  **Client Receives ACK:**
    *   State transitions from `awaitingPush`.
    *   `syncedDoc` is updated by applying the original `outstandingOp`.
    *   `outstandingOp` is cleared.
    *   `serverRevision` is updated.
    *   If `bufferedOp` is null (no edits during push), state becomes `synchronized`.
    *   If `bufferedOp` exists, state becomes `dirty`.
6.  **Other Client Receives Update:**
    *   Client receives `ServerUpdateMsg`.
    *   The incoming server operation is transformed against the client's `outstandingOp` (if any).
    *   The resulting operation is transformed against the client's `bufferedOp` (if any).
    *   The final transformed operation is applied to the editor content (`setEditorValue`).
    *   `syncedDoc` is updated by applying the operation transformed only against `outstandingOp`.
    *   `serverRevision` is updated.
    *   State is re-evaluated (`synchronized` or `dirty`).
7.  **Pull:** User clicks "Pull Changes".
    *   State becomes `awaitingPull`.
    *   `ClientPullMsg` is sent with the current `serverRevision`.
8.  **Server Receives Pull:**
    *   Server retrieves operations from `operationHistory` since the client's `revision`.
    *   `ServerHistoryMsg` is sent back with the list of operations.
9.  **Client Receives History:**
    *   Client iterates through the received operations.
    *   Each operation is transformed against `outstandingOp` and `bufferedOp` (similar to handling `ServerUpdateMsg`).
    *   Operations are applied sequentially to editor content and `syncedDoc`.
    *   `serverRevision` is updated to the latest revision from the message.
    *   State is re-evaluated.

## Limitations & Future Work

*   **Basic Error Handling:** Error conditions (e.g., transform failures, out-of-order messages) are logged but recovery might require a full page refresh or server restart in edge cases.
*   **Scalability:** The current implementation is a prototype and hasn't been optimized for a large number of users or very large documents. Our OT implementation is relatively trivial and simplistic.
*   **Potential Improvements:**
    *   Implement more robust conflict resolution and error recovery strategies.
    *   Explore optimizations for large documents or high-frequency edits.
    *   Add a permission system / ownership of documents to prevent unauthorized access and edits.
    *   Add real-time cursor position indicators to show who is typing.
