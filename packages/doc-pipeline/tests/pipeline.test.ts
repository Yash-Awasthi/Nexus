// SPDX-License-Identifier: Apache-2.0
// Declarative DAG orchestration (haystack Pipeline parity, pass 53): tests pin
// connect-string grammar and errors, topological execution, fan-out, haystack's
// variadic multi-sender ordering, run-input preflight, cycle rejection, and an
// end-to-end composition over doc-pipeline's own chunking primitive.
import { describe, it, expect } from "vitest";
import { ComponentPipeline, chunkText, type PipelineComponent } from "../src/index.js";

/** Records execution order in a shared log. */
function tracked(log: string[], name: string, comp: PipelineComponent): PipelineComponent {
  return {
    ...comp,
    async run(inputs) {
      log.push(name);
      return comp.run(inputs);
    },
  };
}

describe("ComponentPipeline connect grammar + validation", () => {
  it("rejects unknown components on either side", () => {
    const p = new ComponentPipeline().addComponent("a", {
      outputs: ["out"],
      run: () => ({ out: 1 }),
    });
    expect(() => p.connect("a", "ghost")).toThrow(/ghost not found/);
    expect(() => p.connect("ghost", "a")).toThrow(/ghost not found/);
  });

  it("rejects self-connection", () => {
    const p = new ComponentPipeline().addComponent("a", {
      inputs: ["in"],
      outputs: ["out"],
      run: () => ({ out: 1 }),
    });
    expect(() => p.connect("a", "a")).toThrow(/itself/);
  });

  it("rejects unknown and ambiguous sockets", () => {
    const p = new ComponentPipeline()
      .addComponent("src", { outputs: ["x", "y"], run: () => ({ x: 1, y: 2 }) })
      .addComponent("dst", { inputs: ["z"], outputs: ["out"], run: () => ({ out: 1 }) });
    expect(() => p.connect("src.nope", "dst")).toThrow(/does not exist/);
    expect(() => p.connect("src.x", "dst.w")).toThrow(/does not exist/);
    // bare "src" is ambiguous across its two output sockets
    expect(() => p.connect("src", "dst")).toThrow(/ambiguous/);
  });

  it("rejects connecting into a component without declared inputs", () => {
    const p = new ComponentPipeline()
      .addComponent("a", { outputs: ["out"], run: () => ({ out: 1 }) })
      .addComponent("b", { outputs: ["out"], run: () => ({ out: 2 }) });
    expect(() => p.connect("a", "b")).toThrow(/input connections/);
  });
});

describe("ComponentPipeline execution semantics", () => {
  it("runs a linear chain in dependency order with values flowing through", async () => {
    const log: string[] = [];
    const p = new ComponentPipeline()
      .addComponent(
        "seed",
        tracked(log, "seed", { outputs: ["text"], run: () => ({ text: "hello" }) }),
      )
      .addComponent(
        "upper",
        tracked(log, "upper", {
          inputs: ["text"],
          outputs: ["text"],
          run: ({ text }) => ({ text: String(text).toUpperCase() }),
        }),
      )
      .addComponent(
        "wrap",
        tracked(log, "wrap", {
          inputs: ["text"],
          outputs: ["out"],
          run: ({ text }) => ({ out: `[${text}]` }),
        }),
      )
      .connect("seed", "upper")
      .connect("upper", "wrap");

    const r = await p.run();
    expect(log).toEqual(["seed", "upper", "wrap"]);
    expect(r.outputs["wrap"]).toEqual({ out: "[HELLO]" });
  });

  it("fans one output out to multiple receivers", async () => {
    const p = new ComponentPipeline()
      .addComponent("seed", { outputs: ["n"], run: () => ({ n: 7 }) })
      .addComponent("dbl", {
        inputs: ["n"],
        outputs: ["n"],
        run: ({ n }) => ({ n: (n as number) * 2 }),
      })
      .addComponent("tri", {
        inputs: ["n"],
        outputs: ["n"],
        run: ({ n }) => ({ n: (n as number) * 3 }),
      })
      .connect("seed", "dbl")
      .connect("seed", "tri");
    const r = await p.run();
    expect(r.outputs["dbl"]!.n).toBe(14);
    expect(r.outputs["tri"]!.n).toBe(21);
  });

  it("a socket fed by N senders receives N values ordered by sender name", async () => {
    // haystack: multi-sender sockets become variadic; values ordered
    // alphabetically by sender component name
    const p = new ComponentPipeline()
      .addComponent("zeta", { outputs: ["v"], run: () => ({ v: "z" }) })
      .addComponent("alpha", { outputs: ["v"], run: () => ({ v: "a" }) })
      .addComponent("mid", { inputs: ["v"], outputs: ["v"], run: ({ v }) => ({ v }) })
      .connect("zeta", "mid")
      .connect("alpha", "mid");
    const r = await p.run();
    expect(r.outputs["mid"]!.v).toEqual(["a", "z"]);
  });

  it("merges run inputs with connected values; supplied values win", async () => {
    const p = new ComponentPipeline()
      .addComponent("seed", { outputs: ["v"], run: () => ({ v: "connected" }) })
      .addComponent("echo", { inputs: ["v"], outputs: ["v"], run: ({ v }) => ({ v: String(v) }) })
      .connect("seed", "echo");
    const connected = await p.run();
    expect(connected.outputs["echo"]!.v).toBe("connected");

    const overridden = await p.run({ echo: { v: "supplied" } });
    expect(overridden.outputs["echo"]!.v).toBe("supplied");
  });

  it("supplies missing values to an unconnected input from run inputs", async () => {
    const p = new ComponentPipeline().addComponent("sink", {
      inputs: ["text"],
      outputs: ["len"],
      run: ({ text }) => ({ len: String(text).length }),
    });
    const r = await p.run({ sink: { text: "four" } });
    expect(r.outputs["sink"]!.len).toBe(4);
  });

  it("preflights missing declared inputs before execution", async () => {
    const p = new ComponentPipeline().addComponent("sink", {
      inputs: ["text"],
      outputs: ["len"],
      run: () => ({ len: 0 }),
    });
    await expect(p.run()).rejects.toThrow(
      /missing a connection or input value for input socket 'sink.text'/,
    );
  });

  it("rejects run inputs for undeclared sockets", async () => {
    const p = new ComponentPipeline().addComponent("sink", {
      inputs: ["text"],
      outputs: ["len"],
      run: () => ({ len: 0 }),
    });
    await expect(p.run({ sink: { nope: 1 } })).rejects.toThrow(/does not exist/);
  });

  it("rejects run inputs for unknown components", async () => {
    const p = new ComponentPipeline().addComponent("a", { outputs: ["o"], run: () => ({ o: 1 }) });
    await expect(p.run({ ghost: { o: 1 } })).rejects.toThrow(/ghost not found/);
  });

  it("rejects cycles at run time naming the participants", async () => {
    const p = new ComponentPipeline()
      .addComponent("a", { inputs: ["in"], outputs: ["out"], run: ({ in: i }) => ({ out: i }) })
      .addComponent("b", { inputs: ["in"], outputs: ["out"], run: ({ in: i }) => ({ out: i }) })
      .connect("a", "b")
      .connect("b", "a");
    await expect(p.run()).rejects.toThrow(/unsupported cycle involving: (a, b|b, a)/);
  });

  it("supports async components", async () => {
    const p = new ComponentPipeline()
      .addComponent("slow", {
        outputs: ["v"],
        run: async () => ({ v: await Promise.resolve("done") }),
      })
      .addComponent("echo", {
        inputs: ["v"],
        outputs: ["v"],
        run: ({ v }) => ({ v: String(v).toUpperCase() }),
      })
      .connect("slow", "echo");
    const r = await p.run();
    expect(r.outputs["echo"]!.v).toBe("DONE");
  });

  it("validates component outputs against declared sockets", async () => {
    const p = new ComponentPipeline().addComponent("bad", {
      outputs: ["x"],
      run: () => ({ y: 1 }),
    });
    await expect(p.run()).rejects.toThrow(/did not produce declared output 'x'/);
  });
});

describe("ComponentPipeline over doc-pipeline stages", () => {
  it("orchestrates chunk → count as haystack-style components", async () => {
    const chunker: PipelineComponent = {
      inputs: ["text"],
      outputs: ["chunks"],
      run: ({ text }) => ({ chunks: chunkText(String(text), { maxTokens: 8, overlapTokens: 0 }) }),
    };
    const counter: PipelineComponent = {
      inputs: ["chunks"],
      outputs: ["count", "words"],
      run: ({ chunks }) => {
        const list = chunks as { text: string }[];
        return {
          count: list.length,
          words: list.reduce((s, c) => s + c.text.split(/\s+/).length, 0),
        };
      },
    };
    const p = new ComponentPipeline()
      .addComponent("chunker", chunker)
      .addComponent("counter", counter)
      .connect("chunker.chunks", "counter.chunks");
    const longText = Array.from(
      { length: 30 },
      (_, i) => `paragraph number ${i} with several words inside`,
    ).join(". ");
    const r = await p.run({ chunker: { text: longText } });
    const chunks = r.outputs["chunker"]!.chunks as { text: string }[];
    expect(chunks.length).toBeGreaterThan(1); // chunkText really ran over the wire
    // connected value flowed into the counter node, which re-derived its own count
    expect(r.outputs["counter"]!.count).toBe(chunks.length);
    expect(r.outputs["counter"]!.words).toBeGreaterThan(0);
    expect((chunks[0] as { text: string }).text.length).toBeGreaterThan(0);
  });
});
