// src/ot.test.ts
import { describe, it, expect } from "vitest";
import { TextOperation } from "./ot";

// Some useful helpers
function randomString(length: number = 10): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function randomOperation(doc: string): TextOperation {
  // This will produce a simple random op that makes a small modification.
  const op = new TextOperation();
  const docLen = doc.length;
  // Pick a random position (from 0 to docLen)
  const i = Math.floor(Math.random() * (docLen + 1));
  // With a 50% chance, delete a few characters.
  const maxDel = docLen - i;
  let delCount = (maxDel > 0 && Math.random() < 0.5)
    ? Math.floor(Math.random() * maxDel) + 1
    : 0;
  // Build op.
  op.retain(i);
  if (delCount > 0) {
    op.delete(delCount);
  }
  // With a 50% chance, insert a random string.
  if (Math.random() < 0.5) {
    const insLength = Math.floor(Math.random() * 5) + 1;
    op.insert(randomString(insLength));
  }
  op.retain(docLen - i - delCount);
  return op;
}

function randomTest(n: number, testFn: () => void): () => void {
  return () => {
    for (let i = 0; i < n; i++) {
      testFn();
    }
  };
}

describe("TextOperation", () => {
  const doc = "abcdef";

  // --- Basic Operations ---
  it("should correctly apply retain", () => {
    const op = new TextOperation().retain(6);
    expect(op.apply(doc)).toBe("abcdef");
    expect(op.baseLength).toBe(6);
    expect(op.targetLength).toBe(6);
  });

  it("should correctly apply insert", () => {
    const op = new TextOperation().retain(3).insert("XYZ").retain(3);
    expect(op.apply(doc)).toBe("abcXYZdef");
    expect(op.baseLength).toBe(6);
    expect(op.targetLength).toBe(9);
  });

  it("should correctly apply delete", () => {
    const op = new TextOperation().retain(1).delete(3).retain(2);
    expect(op.apply(doc)).toBe("aef");
    expect(op.baseLength).toBe(6);
    expect(op.targetLength).toBe(3);
  });

  it("should correctly apply mixed operations", () => {
    const op = new TextOperation()
      .retain(1) // "abcdef"
      .insert("FOO") // "aFOObcdef"
      .delete(2) // "aFOOdef"
      .retain(2) // "aFOOdef"
      .delete(1) // "aFOODe"
      .insert("BAR"); "aFOOdeBAR"
    expect(op.apply(doc)).toBe("aFOOdeBAR");
    expect(op.baseLength).toBe(6);
  });

  it("should handle edge cases in apply", () => {
    expect(new TextOperation().apply("")).toBe("");
    expect(new TextOperation().insert("abc").apply("")).toBe("abc");
    expect(new TextOperation().delete(3).apply("abc")).toBe("");
    expect(() => new TextOperation().retain(1).apply("")).toThrow();
    expect(() => new TextOperation().delete(1).apply("")).toThrow();
    expect(() => new TextOperation().retain(7).apply(doc)).toThrow();
  });

  // --- Inversion ---
  it("should correctly invert insert", () => {
    const op = new TextOperation().retain(3).insert("XYZ").retain(3);
    const inverted = op.invert(doc);
    const doc2 = op.apply(doc); // "abcXYZdef"
    expect(inverted.apply(doc2)).toBe(doc);
  });

  it("should correctly invert delete", () => {
    const op = new TextOperation().retain(1).delete(3).retain(2); // "aef"
    const inverted = op.invert(doc); // Should insert "bcd"
    const doc2 = op.apply(doc);
    expect(inverted.baseLength).toBe(3);
    expect(inverted.targetLength).toBe(6);
    expect(inverted.apply(doc2)).toBe(doc); // apply(aef, retain(1).insert("bcd").retain(2)) -> abcdef
  });

  it("should correctly invert mixed operations", () => {
    const op = new TextOperation()
      .retain(1)
      .insert("FOO")
      .delete(2)
      .retain(2)
      .delete(1)
      .insert("BAR"); // "aFOOdeBAR"
    const inverted = op.invert(doc); // retain(1).delete(3).insert("bc").retain(2).insert("f").delete(3)
    const doc2 = op.apply(doc);
    expect(inverted.apply(doc2)).toBe(doc);
  });

  // --- Composition ---
  it("should correctly compose insert/insert", () => {
    const op1 = new TextOperation().retain(3).insert("XYZ").retain(3); // abcXYZdef
    const op2 = new TextOperation().retain(6).insert("123").retain(3); // abcXYZ123def
    const composed = op1.compose(op2);
    expect(composed.apply(doc)).toBe("abcXYZ123def");
  });

  it("should correctly compose delete/delete", () => {
    const op1 = new TextOperation().retain(1).delete(2).retain(3); // adef
    const op2 = new TextOperation().retain(1).delete(2).retain(1); // af
    const composed = op1.compose(op2); // retain(1).delete(4).retain(1) -> af
    expect(composed.apply(doc)).toBe("af");
  });

  it("should correctly compose insert/delete", () => {
    const op1 = new TextOperation().retain(3).insert("XYZ").retain(3); // abcXYZdef
    const op2 = new TextOperation().retain(3).delete(3).retain(3); // abcdef
    expect(op2.apply(op1.apply(doc))).toBe("abcdef")
    const composed = op1.compose(op2);
    expect(composed.apply(doc)).toBe("abcdef"); // retain(6) / noop
    expect(composed.isNoop()).toBe(true); // Should be retain(6) or a noop!
  });

  it("should correctly compose delete/insert", () => {
    const op1 = new TextOperation().retain(1).delete(3).retain(2); // aef
    const op2 = new TextOperation().retain(1).insert("BCD").retain(2); // aBCDef
    const composed = op1.compose(op2); // retain(1).delete(3).insert("BCD").retain(2) - No, insert comes first
    // Canonical: retain(1).insert("BCD").delete(3).retain(2) ?
    // apply("abcdef", composed) -> aBCDef
    expect(composed.apply(doc)).toBe("aBCDef");
  });

  it("should correctly compose complex sequences", () => {
    // op1: "abcdef" -> "axYEf" (ins X @ 1, del bc @ 1, ins Y @ 2, del d @ 2)
    const op1 = new TextOperation()
      .retain(1)
      .insert("X")
      .delete(2)
      .insert("Y")
      .delete(1)
      .retain(2); // base=6, target=5. apply("abcdef") -> aXYef
    // op2: "aXYef" -> "aXyef" (del Y @ 2, ins y @ 2)
    const op2 = new TextOperation().retain(2).delete(1).insert("y").retain(2); // base=5, target=5
    const composed = op1.compose(op2);
    const doc2 = op1.apply(doc); // "aXYef"
    const doc3 = op2.apply(doc2); // "aXyef"
    expect(composed.apply(doc)).toBe(doc3);
  });

  // --- Transformation ---
  const transformTest = (
    doc: string,
    op1: TextOperation,
    op2: TextOperation,
  ) => {
    const [op1Prime, op2Prime] = TextOperation.transform(op1, op2);
    const doc1 = op1.apply(doc);
    const doc2 = op2.apply(doc);
    const doc12 = op2Prime.apply(doc1);
    const doc21 = op1Prime.apply(doc2);
    expect(doc12).toBe(doc21);
  };

  it("should transform insert/insert", () => {
    const op1 = new TextOperation().insert("a"); // "a"
    const op2 = new TextOperation().insert("b"); // "b"
    transformTest("", op1, op2);
  });

  it("should transform insert/insert v2", () => {
    const op3 = new TextOperation().retain(2).insert("X").delete(1).retain(3); // abXdef
    const op4 = new TextOperation().retain(4).insert("Y").retain(2); // abcdYef
    transformTest(doc, op3, op4);
  });

  it("should transform delete/delete", () => {
    const op1 = new TextOperation().delete(2).retain(4); // cdef
    const op2 = new TextOperation().retain(1).delete(2).retain(3); // adef
    transformTest(doc, op1, op2);
  });

  it("should transform insert/delete", () => {
    const op1 = new TextOperation().retain(1).insert("XYZ").retain(5); // aXYZbcdef
    const op2 = new TextOperation().retain(3).delete(2).retain(1); // abcf
    transformTest(doc, op1, op2);
  });

  it("should transform delete/insert", () => {
    const op1 = new TextOperation().retain(1).delete(2).retain(3); // adef
    const op2 = new TextOperation().retain(1).insert("BC").retain(5); // aBCbcdef
    transformTest(doc, op1, op2);
  });

  it("should transform concurrent inserts at same position", () => {
    const op1 = new TextOperation().retain(1).insert("X").retain(5); // aXbcdef
    const op2 = new TextOperation().retain(1).insert("Y").retain(5); // aYbcdef
    transformTest(doc, op1, op2);
  });

  it("should transform concurrent deletes of overlapping regions", () => {
    const op1 = new TextOperation().retain(1).delete(3).retain(2); // aef (deletes bcd)
    const op2 = new TextOperation().retain(2).delete(3).retain(1); // abf (deletes cde)
    transformTest(doc, op1, op2);
  });
});


// --- Extended Additional Tests ---
describe("Extended TextOperation Tests", () => {
  it("should correctly compute lengths", () => {
    const op = new TextOperation();
    expect(op.baseLength).toBe(0);
    expect(op.targetLength).toBe(0);
    op.retain(5);
    expect(op.baseLength).toBe(5);
    expect(op.targetLength).toBe(5);
    op.insert("abc");
    expect(op.baseLength).toBe(5);
    expect(op.targetLength).toBe(8);
    op.retain(2);
    expect(op.baseLength).toBe(7);
    expect(op.targetLength).toBe(10);
    op.delete(2);
    expect(op.baseLength).toBe(9);
    expect(op.targetLength).toBe(10);
  });

  it("should chain operations and merge them", () => {
    const op = new TextOperation()
      .retain(5)
      .retain(0)
      .insert("lorem")
      .insert("")
      .delete(3) // delete "abc".length === 3
      .delete(3)
      .delete(0)
      .delete(0);
    // Expect consecutive retains, inserts, deletes to be merged.
    expect(op.ops.length).toBe(3);
    expect(String(op.ops)).toBe(String([5, "lorem", -6]));
  });

  it("should apply random operations correctly (500 iterations)", randomTest(500, () => {
    const str = randomString(50);
    const op = randomOperation(str);
    expect(str.length).toBe(op.baseLength);
    const result = op.apply(str);
    expect(result.length).toBe(op.targetLength);
  }));

  it("should correctly invert random operations (500 iterations)", randomTest(500, () => {
    const str = randomString(50);
    const op = randomOperation(str);
    const inv = op.invert(str);
    const applied = op.apply(str);
    expect(inv.baseLength).toBe(op.targetLength);
    expect(inv.targetLength).toBe(op.baseLength);
    expect(inv.apply(applied)).toBe(str);
  }));

  it("should handle empty operations", () => {
    const op = new TextOperation();
    op.retain(0);
    op.insert('');
    op.delete(0);
    expect(op.ops.length).toBe(0);
  });

  it("should test equality between operations", () => {
    const op1 = new TextOperation().delete(1).insert("lo").retain(2).retain(3);
    const op2 = new TextOperation().delete(1).insert("l").insert("o").retain(5);
    expect(op1.equals(op2)).toBe(true);
    op1.delete(1);
    op2.retain(1);
    expect(op1.equals(op2)).toBe(false);
  });

  it("should merge operations properly", () => {
    const last = <T>(arr: T[]): T => arr[arr.length - 1];
    const op = new TextOperation();
    expect(op.ops.length).toBe(0);
    op.retain(2);
    expect(op.ops.length).toBe(1);
    expect(last(op.ops)).toBe(2);
    op.retain(3);
    expect(op.ops.length).toBe(1);
    expect(last(op.ops)).toBe(5);
    op.insert("abc");
    expect(op.ops.length).toBe(2);
    expect(last(op.ops)).toBe("abc");
    op.insert("xyz");
    expect(op.ops.length).toBe(2);
    expect(last(op.ops)).toBe("abcxyz");
    op.delete(1);
    expect(op.ops.length).toBe(3);
    expect(last(op.ops)).toBe(-1);
    op.delete(1);
    expect(op.ops.length).toBe(3);
    expect(last(op.ops)).toBe(-2);
  });

  it("should correctly determine if an operation is a no-op", () => {
    const op = new TextOperation();
    expect(op.isNoop()).toBe(true);
    op.retain(5);
    expect(op.isNoop()).toBe(true);
    op.retain(3);
    expect(op.isNoop()).toBe(true);
    op.insert("lorem");
    expect(op.isNoop()).toBe(false);
  });

  it("should correctly output a string representation", () => {
    const op = new TextOperation();
    op.retain(2);
    op.insert('lorem');
    op.delete("ipsum".length);
    op.retain(5);
    expect(op.toString()).toBe("retain 2, insert 'lorem', delete 5, retain 5");
  });

  it("should serialize and deserialize correctly (JSON round-trip)", () => {
    const str = randomString(50);
    const operation = randomOperation(str);
    const json = operation.toJSON();
    const opFromJson = TextOperation.fromJSON(json);
    expect(operation.equals(opFromJson)).toBe(true);
  });

  it("should create an operation from JSON and reject malformed JSON", () => {
    const ops = [2, -1, -1, 'cde'];
    const op = TextOperation.fromJSON(ops);
    expect(op.ops.length).toBe(3);
    expect(op.baseLength).toBe(4);
    expect(op.targetLength).toBe(5);

    const badOps1 = [...ops, { insert: 'x' }];
    expect(() => TextOperation.fromJSON(badOps1)).toThrow();
    const badOps2 = [...ops, null];
    expect(() => TextOperation.fromJSON(badOps2)).toThrow();
  });

  it("should compose operations properly", randomTest(500, () => {
    const str = randomString(20);
    const a = randomOperation(str);
    const afterA = a.apply(str);
    expect(a.targetLength).toBe(afterA.length);
    const b = randomOperation(afterA);
    const afterB = b.apply(afterA);
    expect(b.targetLength).toBe(afterB.length);
    const ab = a.compose(b);
    expect(ab.targetLength).toBe(b.targetLength);
    expect(ab.apply(str)).toBe(afterB);
  }));

  it("should satisfy the transform invariant", randomTest(500, () => {
    const str = randomString(20);
    const a = randomOperation(str);
    const b = randomOperation(str);
    const [aPrime, bPrime] = TextOperation.transform(a, b);
    const abPrime = a.compose(bPrime);
    const baPrime = b.compose(aPrime);
    expect(abPrime.equals(baPrime)).toBe(true);
    expect(abPrime.apply(str)).toBe(baPrime.apply(str));
  }));
});
