// SPDX-License-Identifier: Apache-2.0
/**
 * Declarative DAG component orchestration (haystack Pipeline parity, pass 53).
 *
 * @nexus/doc-pipeline's `runDocPipeline` is a fixed linear chain (Extract →
 * Chunk → Embed → Store). haystack's distinctive mechanic — row 104's
 * "Pipelines orchestration unported" — is a declarative graph of components
 * wired by named connections and executed in dependency order. This module
 * ports that core:
 *
 *   • addComponent(name, { inputs, outputs, run })  — declare sockets explicitly
 *   • connect("a", "b") / connect("a.out", "b.in")  — wire sender → receiver
 *   • run({ comp: { input: value } })               — execute topologically
 *
 * Semantics mirror haystack's core/pipeline/base.py where groundable:
 *   • connect-string grammar "component.socket"; bare names resolve only when
 *     the component declares exactly one socket of that kind.
 *   • Errors at connect time: unknown component, unknown socket, self-connect,
 *     ambiguous bare name. Errors at run time: unresolved cycle (haystack's
 *     loop support is out of scope — noted) and missing declared inputs
 *     (haystack preflights these before execution).
 *   • Fan-out: one output socket may feed any number of receivers.
 *   • Multi-sender input: when N senders feed one input socket the receiver
 *     gets a list of the N values ordered alphabetically by sender component
 *     name — haystack's documented variadic-socket ordering for `run`.   * • run(inputs) takes haystack's nested form — {"comp": {"socket": value}};
 *     a socket that is connected AND supplied receives the supplied value
 *     (documented port choice, useful for overriding in tests).
 * • Each component receives only its declared inputs; outputs are validated
 *     against the declared output socket names.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineComponent {
  /** Declared input socket names. Omit to accept any keys at run time. */
  inputs?: string[];
  /** Declared output socket names (validated after each run). */
  outputs: string[];
  /** Execute with the merged input values for this component. */
  run(inputs: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export type ConnectError = Error & { name: string };

function connectError(message: string): ConnectError {
  const err = new Error(message) as ConnectError;
  err.name = "PipelineConnectError";
  return err;
}

/** Split "component" / "component.socket"; returns [name, socket | undefined]. */
function parseConnectString(ref: string): [string, string | undefined] {
  const idx = ref.indexOf(".");
  return idx === -1 ? [ref.trim(), undefined] : [ref.slice(0, idx).trim(), ref.slice(idx + 1)];
}

/** Pick one socket by name, resolving bare references only when unambiguous. */
function resolveSocket(
  kind: "input" | "output",
  component: string,
  socket: string | undefined,
  declared: string[],
): string {
  if (socket !== undefined) {
    if (!declared.includes(socket)) {
      throw connectError(
        `'${component}.${socket}' does not exist. ${kind} sockets of ${component} are: ${declared.join(", ") || "(none)"}`,
      );
    }
    return socket;
  }
  if (declared.length === 1) return declared[0]!;
  if (declared.length === 0) {
    throw connectError(
      `'${component}' does not have any ${kind} connections. Declare ${kind}s on the component to connect it.`,
    );
  }
  throw connectError(
    `'${component}' is ambiguous: it declares ${declared.length} ${kind} sockets (${declared.join(", ")}). ` +
      `Specify '${component}.${declared[0]}' explicitly.`,
  );
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface PipelineRunResult {
  /** Outputs of every executed component, keyed by component name. */
  outputs: Record<string, Record<string, unknown>>;
}

interface Edge {
  senderComponent: string;
  senderSocket: string;
  receiverComponent: string;
  receiverSocket: string;
}

export class ComponentPipeline {
  private readonly components = new Map<string, PipelineComponent>();
  private readonly edges: Edge[] = [];
  private readonly connections = new Map<string, Edge[]>(); // `${recv}.${socket}` → edges

  /** Add a component under a unique name. */
  addComponent(name: string, component: PipelineComponent): this {
    if (this.components.has(name)) {
      throw connectError(`Component named ${name} already exists in the pipeline.`);
    }
    if (component.outputs.length === 0) {
      throw connectError(`Component named ${name} does not declare any outputs.`);
    }
    this.components.set(name, component);
    return this;
  }

  /**
   * Connect a sender to a receiver. Accepts "component" or "component.socket"
   * on either side (haystack connect-string grammar).
   */
  connect(sender: string, receiver: string): this {
    const [senderName, senderRef] = parseConnectString(sender);
    const [receiverName, receiverRef] = parseConnectString(receiver);

    const senderComp = this.components.get(senderName);
    if (!senderComp) throw connectError(`Component named ${senderName} not found in the pipeline.`);
    const receiverComp = this.components.get(receiverName);
    if (!receiverComp)
      throw connectError(`Component named ${receiverName} not found in the pipeline.`);
    if (senderName === receiverName) {
      throw connectError("Connecting a Component to itself is not supported.");
    }

    const senderSocket = resolveSocket("output", senderName, senderRef, senderComp.outputs);
    const receiverSocket = resolveSocket(
      "input",
      receiverName,
      receiverRef,
      receiverComp.inputs ?? [],
    );

    const edge: Edge = {
      senderComponent: senderName,
      senderSocket,
      receiverComponent: receiverName,
      receiverSocket,
    };
    this.edges.push(edge);
    const key = `${receiverName}.${receiverSocket}`;
    const list = this.connections.get(key);
    if (list) list.push(edge);
    else this.connections.set(key, [edge]);
    return this;
  }

  /**
   * Execute the pipeline. `inputs` maps "component" or "component.socket" to
   * caller-supplied values for sockets that are not (or additionally are)
   * connected. Returns every executed component's outputs.
   */
  async run(inputs: Record<string, Record<string, unknown>> = {}): Promise<PipelineRunResult> {
    // ── Resolve caller inputs — haystack's nested {"comp": {"socket": value}} ─
    const provided = new Map<string, Map<string, unknown>>();
    for (const [name, socketValues] of Object.entries(inputs)) {
      const comp = this.components.get(name);
      if (!comp) throw new Error(`Component named ${name} not found in the pipeline.`);
      if (
        socketValues === null ||
        typeof socketValues !== "object" ||
        Array.isArray(socketValues)
      ) {
        throw new Error(
          `Inputs for '${name}' must be an object mapping socket names to values, got: ${JSON.stringify(socketValues)}.`,
        );
      }
      const declared = comp.inputs ?? [];
      for (const [socket, value] of Object.entries(socketValues)) {
        if (declared.length > 0 && !declared.includes(socket)) {
          throw new Error(
            `'${name}.${socket}' does not exist. Input sockets of ${name} are: ${declared.join(", ")}.`,
          );
        }
        if (!provided.has(name)) provided.set(name, new Map());
        provided.get(name)!.set(socket, value);
      }
    }

    // ── Preflight: every declared input must be connected or provided ───────
    for (const [name, comp] of this.components) {
      for (const socket of comp.inputs ?? []) {
        const key = `${name}.${socket}`;
        const connected = this.connections.has(key);
        const supplied = provided.get(name)?.has(socket) ?? false;
        if (!connected && !supplied) {
          throw new Error(
            `Pipeline is missing a connection or input value for input socket '${name}.${socket}'.`,
          );
        }
      }
    }

    // ── Topological order (Kahn) over component edges ───────────────────────
    const inDegree = new Map<string, number>();
    for (const name of this.components.keys()) inDegree.set(name, 0);
    const downstream = new Map<string, string[]>();
    for (const e of this.edges) {
      inDegree.set(e.receiverComponent, (inDegree.get(e.receiverComponent) ?? 0) + 1);
      const list = downstream.get(e.senderComponent);
      if (list) list.push(e.receiverComponent);
      else downstream.set(e.senderComponent, [e.receiverComponent]);
    }
    const ready = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
    const order: string[] = [];
    while (ready.length > 0) {
      const name = ready.shift()!;
      order.push(name);
      for (const next of downstream.get(name) ?? []) {
        const d = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, d);
        if (d === 0) ready.push(next);
      }
    }
    if (order.length !== this.components.size) {
      const cycle = [...this.components.keys()].filter((n) => (inDegree.get(n) ?? 0) > 0);
      throw new Error(
        `Pipeline contains an unsupported cycle involving: ${cycle.join(", ")}. ` +
          `This port executes acyclic DAGs only (haystack loop components are out of scope).`,
      );
    }

    // ── Execute in dependency order ──────────────────────────────────────────
    const outputs = new Map<string, Record<string, unknown>>();
    for (const name of order) {
      const comp = this.components.get(name)!;
      const inputValues = new Map<string, unknown>();

      // Connected inputs: a socket with N senders receives N values ordered
      // alphabetically by sender component name (haystack's variadic order).
      for (const socket of comp.inputs ?? []) {
        const incoming = this.connections.get(`${name}.${socket}`);
        if (incoming && incoming.length > 0) {
          const sorted = [...incoming].sort((a, b) =>
            a.senderComponent < b.senderComponent ? -1 : 1,
          );
          const values = sorted.map((e) => {
            const senderOut = outputs.get(e.senderComponent);
            if (!senderOut) {
              throw new Error(
                `Component '${e.senderComponent}' produced no output for '${e.senderComponent}.${e.senderSocket}'.`,
              );
            }
            return senderOut[e.senderSocket];
          });
          inputValues.set(socket, incoming.length === 1 ? values[0] : values);
        }
      }
      // Caller-supplied inputs override connected values (haystack semantics).
      for (const [k, v] of provided.get(name) ?? new Map<string, unknown>())
        inputValues.set(k, v as string);

      const result = await comp.run(Object.fromEntries(inputValues));
      for (const socket of comp.outputs) {
        if (!(socket in result)) {
          throw new Error(
            `Component '${name}' did not produce declared output '${socket}'. ` +
              `Produced keys: ${Object.keys(result).join(", ") || "(none)"}.`,
          );
        }
      }
      outputs.set(name, result);
    }

    return { outputs: Object.fromEntries(outputs) };
  }
}
