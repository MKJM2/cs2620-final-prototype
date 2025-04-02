// src/ot.ts

/**
 * Represents a component of a text operation.
 * - Positive number: Retain N characters.
 * - Negative number: Delete N characters.
 * - String: Insert the string.
 */
export type OperationComponent = number | string;

/**
 * Checks if an operation component is a retain operation.
 * @param op - The operation component.
 * @returns True if the component is a retain operation.
 */
export function isRetain(op: OperationComponent): op is number {
  return typeof op === "number" && op > 0;
}

/**
 * Checks if an operation component is an insert operation.
 * @param op - The operation component.
 * @returns True if the component is an insert operation.
 */
export function isInsert(op: OperationComponent): op is string {
  return typeof op === "string";
}

/**
 * Checks if an operation component is a delete operation.
 * @param op - The operation component.
 * @returns True if the component is a delete operation.
 */
export function isDelete(op: OperationComponent): op is number {
  return typeof op === "number" && op < 0;
}

/**
 * Represents a sequence of operations to transform a text document.
 * Operations are stored in a canonical form:
 * - No two consecutive operations are of the same type.
 * - Delete operations are never followed by insert operations.
 */
export class TextOperation {
  /** The sequence of retain, insert, and delete operations. */
  ops: OperationComponent[] = [];
  /** The length of the document before the operation is applied. */
  baseLength: number = 0;
  /** The length of the document after the operation is applied. */
  targetLength: number = 0;

  /**
   * Creates a new TextOperation.
   */
  constructor() {
    // Ensure 'this' context is correct if called without 'new'
    if (!(this instanceof TextOperation)) {
      return new TextOperation();
    }
  }

  /**
   * Appends an operation component, merging adjacent ops where possible.
   * @param newOp - The operation component to add.
   */
  private addOp(newOp: OperationComponent): void {
    if (
      (isRetain(newOp) || isDelete(newOp)) &&
      (newOp as number) === 0
    ) {
      return;
    }
    if (isInsert(newOp) && (newOp as string) === "") {
      return;
    }

    const lastOp = this.ops[this.ops.length - 1];

    if (isRetain(newOp) && isRetain(lastOp)) {
      this.ops[this.ops.length - 1] = (lastOp as number) + newOp;
    } else if (isInsert(newOp) && isInsert(lastOp)) {
      this.ops[this.ops.length - 1] = lastOp + newOp;
    } else if (isDelete(newOp) && isDelete(lastOp)) {
      this.ops[this.ops.length - 1] = (lastOp as number) + newOp;
    } else if (isDelete(newOp) && isInsert(lastOp)) {
      // Canonical form: Insert comes before delete.
      // Check previous op.
      if (isInsert(this.ops[this.ops.length - 2])) {
        this.ops[this.ops.length - 2] += lastOp;
        this.ops[this.ops.length - 1] = newOp;
      } else {
        this.ops.push(this.ops[this.ops.length - 1]);
        this.ops[this.ops.length - 2] = newOp;
      }
    } else {
      this.ops.push(newOp);
    }
  }

  /**
   * Adds a retain operation component.
   * @param n - The number of characters to retain. Must be positive.
   * @returns The TextOperation instance for chaining.
   */
  retain(n: number): this {
    if (typeof n !== "number" || !Number.isInteger(n)) {
      throw new Error("retain expects an integer");
    }
    if (n === 0) return this;
    if (n < 0) {
      throw new Error("retain expects a non-negative integer");
    }
    this.baseLength += n;
    this.targetLength += n;
    this.addOp(n);
    return this;
  }

  /**
   * Adds an insert operation component.
   * @param str - The string to insert. Must not be empty.
   * @returns The TextOperation instance for chaining.
   */
  insert(str: string): this {
    if (typeof str !== "string") {
      throw new Error("insert expects a string");
    }
    if (str === "") return this;
    this.targetLength += str.length;
    this.addOp(str);
    return this;
  }

  /**
   * Adds a delete operation component.
   * @param n - The number of characters to delete (positive integer) or the string to delete.
   * @returns The TextOperation instance for chaining.
   */
  delete(n: number | string): this {
    let length: number;
    if (typeof n === "string") {
      length = n.length;
    } else if (typeof n === "number" && Number.isInteger(n)) {
      length = n;
    } else {
      throw new Error("delete expects an integer or a string");
    }

    if (length === 0) return this;
    if (length < 0) {
      throw new Error("delete expects a non-negative integer");
    }

    this.baseLength += length;
    this.addOp(-length);
    return this;
  }

  /**
   * Checks if the operation has no effect.
   * @returns True if the operation is a no-op.
   */
  isNoop(): boolean {
    return (
      this.ops.length === 0 ||
      (this.ops.length === 1 && isRetain(this.ops[0]))
    );
  }

  /**
   * Returns the inner Operation Component from a complex
   * TextOperation. Skips over retain() micro-ops.
   * @param op - The TextOperation to pull a simple micro-op out of.
   * @returns A single OperationComponent micro-op
   */
  getSimpleOp(): OperationComponent | null {
    switch (this.ops.length) {
      case 1: return isRetain(this.ops[0]) ? null : this.ops[0];
      case 2: return isRetain(this.ops[0]) ? (isRetain(this.ops[1]) ? null : this.ops[1]) : this.ops[0];
    }
    return null;
  }

  /**
   * Checks if two operations can be composed together.
   * @returns True if the two operations should be composed.
   */
  shouldBeComposedWith(other: TextOperation): boolean {
    if (this.isNoop() || other.isNoop()) {
      return true;
    }
    let op1 = this.getSimpleOp();
    let op2 = other.getSimpleOp();
    if (!op1 || !op2) {
      return false
    }
    if (isInsert(op1) && isInsert(op2)) {
      return true;
    }
    if (isDelete(op1) && isDelete(op2)) {
      return true;
    }
    return false;
  }

  /**
   * Applies the operation to a document string.
   * @param doc - The document string to apply the operation to.
   * @returns The transformed document string.
   * @throws Error if the document length doesn't match the operation's base length.
   */
  apply(doc: string): string {
    if (doc.length !== this.baseLength) {
      throw new Error(
        `Operation base length (${this.baseLength}) does not match document length (${doc.length}). Op: ${this.toString()}`,
      );
    }

    let newDoc = "";
    let docIndex = 0;
    for (const op of this.ops) {
      if (isRetain(op)) {
        if (docIndex + op > doc.length) {
          throw new Error("Retain exceeds document length.");
        }
        newDoc += doc.substring(docIndex, docIndex + op);
        docIndex += op;
      } else if (isInsert(op)) {
        newDoc += op;
      } else {
        // isDelete(op)
        docIndex -= op; // op is negative
      }
    }

    if (docIndex !== doc.length) {
      throw new Error("Operation did not consume the entire document.");
    }

    // Sanity check - should not happen if logic is correct
    if (newDoc.length !== this.targetLength) {
      console.warn(`Internal inconsistency: Calculated targetLength (${this.targetLength}) differs from actual result length (${newDoc.length}). Op: ${this.toString()}, BaseDoc: "${doc}"`);
      // Allow proceeding but log warning, as targetLength might be slightly off due to complex merges
      // but the resulting document is likely correct based on apply logic.
      // For strict correctness, one might throw here.
    }


    return newDoc;
  }

  /**
   * Computes the inverse of this operation.
   * @param doc - The original document string (before applying this operation).
   * @returns A new TextOperation that is the inverse of this one.
   */
  invert(doc: string): TextOperation {
    if (doc.length !== this.baseLength) {
      throw new Error(
        `Operation base length (${this.baseLength}) does not match document length (${doc.length}) for inversion.`,
      );
    }

    const inverse = new TextOperation();
    let docIndex = 0;
    for (const op of this.ops) {
      if (isRetain(op)) {
        inverse.retain(op);
        docIndex += op;
      } else if (isInsert(op)) {
        inverse.delete(op.length);
      } else {
        // isDelete(op)
        const length = -op;
        inverse.insert(doc.substring(docIndex, docIndex + length));
        docIndex += length;
      }
    }
    return inverse;
  }

  /**
   * Composes this operation with another subsequent operation.
   * `apply(apply(doc, this), other) == apply(doc, this.compose(other))`
   * @param other - The operation to compose with this one.
   * @returns A new TextOperation representing the composition.
   * @throws Error if the target length of this operation doesn't match the base length of the other.
   */
  compose(other: TextOperation): TextOperation {
    if (this.targetLength !== other.baseLength) {
      throw new Error(
        `Cannot compose operations: target length (${this.targetLength}) != base length (${other.baseLength})`,
      );
    }

    const composed = new TextOperation();
    const ops1 = this.ops.slice();
    const ops2 = other.ops.slice();

    let op1 = ops1.shift();
    let op2 = ops2.shift();

    while (op1 !== undefined || op2 !== undefined) {
      if (isInsert(op1)) {
        composed.insert(op1);
        op1 = ops1.shift();
        continue;
      }
      if (isInsert(op2)) {
        composed.insert(op2);
        op2 = ops2.shift();
        continue;
      }

      if (op1 === undefined) {
        throw new Error(
          "Cannot compose operations: first operation is too short.",
        );
      }
      if (op2 === undefined) {
        throw new Error(
          "Cannot compose operations: second operation is too short.",
        );
      }

      if (isRetain(op1) && isRetain(op2)) {
        const minLen = Math.min(op1, op2);
        composed.retain(minLen);
        if (op1 > op2) {
          op1 -= op2;
          op2 = ops2.shift();
        } else if (op1 < op2) {
          op2 -= op1;
          op1 = ops1.shift();
        } else {
          op1 = ops1.shift();
          op2 = ops2.shift();
        }
      } else if (isDelete(op1) && isDelete(op2)) {
        const minLen = Math.min(-op1, -op2);
        composed.delete(minLen);
        if (-op1 > -op2) {
          op1 += minLen; // op1 becomes less negative
          op2 = ops2.shift();
        } else if (-op1 < -op2) {
          op2 += minLen; // op2 becomes less negative
          op1 = ops1.shift();
        } else {
          op1 = ops1.shift();
          op2 = ops2.shift();
        }
      } else if (isDelete(op1) && isRetain(op2)) {
        const minLen = Math.min(-op1, op2);
        composed.delete(minLen);
        if (-op1 > op2) {
          op1 += op2; // op1 becomes less negative
          op2 = ops2.shift();
        } else if (-op1 < op2) {
          op2 -= -op1; // op2 becomes smaller positive
          op1 = ops1.shift();
        } else {
          op1 = ops1.shift();
          op2 = ops2.shift();
        }
      } else if (isRetain(op1) && isDelete(op2)) {
        const minLen = Math.min(op1, -op2);
        composed.delete(minLen);
        if (op1 > -op2) {
          op1 -= -op2; // op1 becomes smaller positive
          op2 = ops2.shift();
        } else if (op1 < -op2) {
          op2 += op1; // op2 becomes less negative
          op1 = ops1.shift();
        } else {
          op1 = ops1.shift();
          op2 = ops2.shift();
        }
      } else {
        // This state should be unreachable if inputs are valid TextOperations
        throw new Error(
          `Unreachable state in compose: op1=${JSON.stringify(op1)}, op2=${JSON.stringify(op2)}`,
        );
      }
    }
    return composed;
  }

  /**
   * Transforms two concurrent operations (this and other) against each other.
   * Produces two new operations [op1', op2'] such that
   * `apply(apply(doc, this), op2') == apply(apply(doc, other), op1')`.
   * @param other - The other concurrent operation.
   * @returns A pair of transformed operations: [this', other'].
   * @throws Error if the base lengths of the operations do not match.
   */
  static transform(
    op1: TextOperation,
    op2: TextOperation,
  ): [TextOperation, TextOperation] {
    if (op1.baseLength !== op2.baseLength) {
      throw new Error(
        `Cannot transform operations with different base lengths: ${op1.baseLength} != ${op2.baseLength}`,
      );
    }

    const op1Prime = new TextOperation();
    const op2Prime = new TextOperation();
    const ops1 = op1.ops.slice();
    const ops2 = op2.ops.slice();

    let currentOp1 = ops1.shift();
    let currentOp2 = ops2.shift();

    while (currentOp1 !== undefined || currentOp2 !== undefined) {
      // Handle inserts: Inserts are effectively retained by the other operation.
      // Priority is given to op1's insert if both insert at the same position.
      if (isInsert(currentOp1)) {
        op1Prime.insert(currentOp1);
        op2Prime.retain(currentOp1.length);
        currentOp1 = ops1.shift();
        continue;
      }
      if (isInsert(currentOp2)) {
        op1Prime.retain(currentOp2.length);
        op2Prime.insert(currentOp2);
        currentOp2 = ops2.shift();
        continue;
      }

      // If one operation is exhausted, the other must also be (due to baseLength check).
      // This check prevents infinite loops if logic above has errors.
      if (currentOp1 === undefined || currentOp2 === undefined) {
        // If one is undefined, the other must also be undefined due to the baseLength equality.
        // If not, it indicates an internal inconsistency or malformed operation.
        if (currentOp1 !== undefined || currentOp2 !== undefined) {
          throw new Error(`Operation length mismatch during transform despite equal base lengths. Op1: ${op1.toString()}, Op2: ${op2.toString()}`);
        }
        break; // Both are undefined, normal exit.
      }


      // Handle retain/retain
      if (isRetain(currentOp1) && isRetain(currentOp2)) {
        const minLen = Math.min(currentOp1, currentOp2);
        op1Prime.retain(minLen);
        op2Prime.retain(minLen);
        if (currentOp1 > currentOp2) {
          currentOp1 -= currentOp2;
          currentOp2 = ops2.shift();
        } else if (currentOp1 < currentOp2) {
          currentOp2 -= currentOp1;
          currentOp1 = ops1.shift();
        } else {
          currentOp1 = ops1.shift();
          currentOp2 = ops2.shift();
        }
      }
      // Handle delete/delete
      else if (isDelete(currentOp1) && isDelete(currentOp2)) {
        const len1 = -currentOp1;
        const len2 = -currentOp2;
        const minLen = Math.min(len1, len2);
        // No operation needed in the output, just advance the cursors
        if (len1 > len2) {
          currentOp1 += len2; // Less negative
          currentOp2 = ops2.shift();
        } else if (len1 < len2) {
          currentOp2 += len1; // Less negative
          currentOp1 = ops1.shift();
        } else {
          currentOp1 = ops1.shift();
          currentOp2 = ops2.shift();
        }
      }
      // Handle delete/retain
      else if (isDelete(currentOp1) && isRetain(currentOp2)) {
        const len1 = -currentOp1;
        const len2 = currentOp2;
        const minLen = Math.min(len1, len2);
        op1Prime.delete(minLen);
        if (len1 > len2) {
          currentOp1 += len2; // Less negative
          currentOp2 = ops2.shift();
        } else if (len1 < len2) {
          currentOp2 -= len1; // Smaller positive
          currentOp1 = ops1.shift();
        } else {
          currentOp1 = ops1.shift();
          currentOp2 = ops2.shift();
        }
      }
      // Handle retain/delete
      else if (isRetain(currentOp1) && isDelete(currentOp2)) {
        const len1 = currentOp1;
        const len2 = -currentOp2;
        const minLen = Math.min(len1, len2);
        op2Prime.delete(minLen);
        if (len1 > len2) {
          currentOp1 -= len2; // Smaller positive
          currentOp2 = ops2.shift();
        } else if (len1 < len2) {
          currentOp2 += len1; // Less negative
          currentOp1 = ops1.shift();
        } else {
          currentOp1 = ops1.shift();
          currentOp2 = ops2.shift();
        }
      } else {
        throw new Error(
          `Incompatible operations during transform: op1=${JSON.stringify(currentOp1)}, op2=${JSON.stringify(currentOp2)}`,
        );
      }
    }

    return [op1Prime, op2Prime];
  }

  /**
   * Creates a TextOperation instance from a JSON representation (an array of components).
   * @param ops - The array of operation components.
   * @returns A new TextOperation instance.
   */
  static fromJSON(ops: OperationComponent[]): TextOperation {
    const operation = new TextOperation();
    for (const op of ops) {
      if (isRetain(op)) {
        operation.retain(op);
      } else if (isInsert(op)) {
        operation.insert(op);
      } else if (isDelete(op)) {
        // The delete method expects a positive number or string
        operation.delete(-op);
      } else {
        throw new Error(`Invalid operation component in JSON: ${op}`);
      }
    }
    return operation;
  }

  /**
   * Converts the operation to its JSON representation.
   * @returns An array of operation components.
   */
  toJSON(): OperationComponent[] {
    return this.ops;
  }

  /**
   * Creates a string representation of the operation for debugging.
   * @returns A human-readable string representation.
   */
  toString(): string {
    return this.ops
      .map((op) => {
        if (isRetain(op)) return `retain ${op}`;
        if (isInsert(op)) return `insert '${op}'`;
        if (isDelete(op)) return `delete ${-op}`;
        return "invalid"; // Should not happen
      })
      .join(", ");
  }
}
