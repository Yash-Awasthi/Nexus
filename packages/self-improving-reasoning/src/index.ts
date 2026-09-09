// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/self-improving-reasoning — Self-improving Chain-of-Thought reasoning pipeline.
 *
 * Generates reasoning traces, self-evaluates them, and iteratively refines
 * using feedback.  Implements the STaR (Self-Taught Reasoner) methodology
 * from CAMEL's SelfImprovingCoTPipeline.
 *
 * Flow:
 *   1. Initial reasoning trace generation
 *   2. Self-evaluation (correctness, clarity, completeness)
 *   3. Feedback-based improvement
 *   4. Iterative refinement until quality threshold or max iterations
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReasoningProblem {
  id?: string;
  problem: string;
  /** Optional expected answer for auto-scoring */
  expectedAnswer?: string;
  /** Problem type (e.g. "math", "logic", "coding", "analysis") */
  type?: string;
}

export interface TraceEvaluation {
  correctness: number; // 0-1
  clarity: number; // 0-1
  completeness: number; // 0-1
  feedback: string;
  /** Overall quality score (weighted average) */
  overallScore: number;
}

export interface TraceIteration {
  iteration: number;
  trace: string;
  evaluation: TraceEvaluation;
  /** Time taken to generate this trace in ms */
  durationMs: number;
}

export interface ProblemResult {
  problem: ReasoningProblem;
  /** The final best trace */
  finalTrace: string;
  /** The extracted answer (if any) */
  answer?: string;
  /** Whether the answer matches expected */
  answerCorrect?: boolean;
  /** Full improvement history */
  history: TraceIteration[];
  /** Total iterations performed */
  totalIterations: number;
  /** Whether quality threshold was met */
  qualityMet: boolean;
}

export interface PipelineConfig {
  /** LLM function: takes a prompt and returns a completion */
  llm: (prompt: string) => Promise<string>;
  /** Evaluator function: scores a trace (optional — uses LLM-based eval if not provided) */
  evaluator?: (problem: string, trace: string) => Promise<TraceEvaluation>;
  /** Maximum iterations per problem (default: 5) */
  maxIterations?: number;
  /** Quality threshold to stop early (default: 0.8) */
  qualityThreshold?: number;
  /** Minimum improvement to continue iterating (default: 0.02) */
  minImprovement?: number;
  /** Temperature for trace generation (default: 0.7) */
  temperature?: number;
  /** Temperature for evaluation (default: 0.0) */
  evalTemperature?: number;
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

const EVAL_PROMPT = `You are an expert evaluator of reasoning traces. Analyze the following reasoning trace for a given problem and evaluate it on three dimensions.

Problem:
{problem}

Reasoning Trace:
{trace}

Evaluate the trace on these dimensions (0.0 to 1.0 each):
1. **Correctness**: Is the reasoning logically sound? Are the conclusions valid?
2. **Clarity**: Is the reasoning easy to follow? Are the steps well-structured?
3. **Completeness**: Does the trace cover all necessary aspects? Are there gaps?

Also provide specific feedback on how to improve the trace.

Respond in this exact JSON format:
{{
  "correctness": <0.0-1.0>,
  "clarity": <0.0-1.0>,
  "completeness": <0.0-1.0>,
  "feedback": "<specific improvement suggestions>"
}}`;

function parseEvaluation(text: string): TraceEvaluation | null {
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const correctness = Math.max(0, Math.min(1, parsed.correctness ?? 0.5));
    const clarity = Math.max(0, Math.min(1, parsed.clarity ?? 0.5));
    const completeness = Math.max(0, Math.min(1, parsed.completeness ?? 0.5));
    const feedback = parsed.feedback ?? "No feedback provided.";

    const overallScore = correctness * 0.4 + clarity * 0.2 + completeness * 0.4;

    return { correctness, clarity, completeness, feedback, overallScore };
  } catch {
    return null;
  }
}

/**
 * Default LLM-based evaluator.
 */
export function createLlmEvaluator(
  llm: (prompt: string) => Promise<string>,
  temperature = 0,
): (problem: string, trace: string) => Promise<TraceEvaluation> {
  return async (problem: string, trace: string): Promise<TraceEvaluation> => {
    const prompt = EVAL_PROMPT.replace("{problem}", problem).replace("{trace}", trace);

    const response = await llm(prompt);
    const evaluation = parseEvaluation(response);

    if (evaluation) return evaluation;

    // Fallback: basic heuristic evaluation
    const words = trace.split(/\s+/).length;
    const hasSteps = /\d+[\.\)]\s/.test(trace) || /step/i.test(trace);
    const hasConclusion = /therefore|thus|conclusion|answer/i.test(trace);

    return {
      correctness: 0.5,
      clarity: hasSteps ? 0.7 : 0.4,
      completeness: hasConclusion ? 0.7 : 0.5,
      feedback: "LLM evaluation failed; using heuristic fallback.",
      overallScore: 0.55,
    };
  };
}

// ─── Prompt Templates ────────────────────────────────────────────────────────

const INITIAL_TRACE_PROMPT = `Solve the following problem step by step. Show your complete reasoning.

Problem: {problem}

Think carefully and provide a detailed, structured solution. Use numbered steps where appropriate.`;

const IMPROVEMENT_PROMPT = `You previously attempted to solve this problem but your solution had issues.

Problem: {problem}

Your previous attempt:
{previousTrace}

Evaluation feedback:
{feedback}

Please try again, addressing the feedback. Provide an improved solution that fixes the issues identified.`;

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Self-improving CoT reasoning pipeline.
 * Generates traces, evaluates them, and iteratively refines.
 */
export class SelfImprovingReasoningPipeline {
  private config: Required<PipelineConfig>;
  private evaluator: (problem: string, trace: string) => Promise<TraceEvaluation>;

  constructor(config: PipelineConfig) {
    this.config = {
      evaluator: createLlmEvaluator(config.llm, config.evalTemperature),
      maxIterations: 5,
      qualityThreshold: 0.8,
      minImprovement: 0.02,
      temperature: 0.7,
      evalTemperature: 0,
      ...config,
    };
    this.evaluator = this.config.evaluator;
  }

  /**
   * Run the pipeline on a single problem.
   */
  async solve(problem: ReasoningProblem): Promise<ProblemResult> {
    const history: TraceIteration[] = [];
    let bestTrace = "";
    let bestScore = -1;

    // Step 1: Initial generation
    const initialPrompt = INITIAL_TRACE_PROMPT.replace("{problem}", problem.problem);
    const startTime = Date.now();
    let trace = await this.config.llm(initialPrompt);
    let evaluation = await this.evaluator(problem.problem, trace);
    const duration = Date.now() - startTime;

    history.push({
      iteration: 0,
      trace,
      evaluation,
      durationMs: duration,
    });

    bestTrace = trace;
    bestScore = evaluation.overallScore;

    // Step 2: Iterative refinement
    for (let i = 1; i < this.config.maxIterations; i++) {
      // Check quality threshold
      if (bestScore >= this.config.qualityThreshold) {
        break;
      }

      const iterStart = Date.now();
      const improvePrompt = IMPROVEMENT_PROMPT.replace("{problem}", problem.problem)
        .replace("{previousTrace}", bestTrace)
        .replace("{feedback}", evaluation.feedback);

      trace = await this.config.llm(improvePrompt);
      evaluation = await this.evaluator(problem.problem, trace);
      const iterDuration = Date.now() - iterStart;

      history.push({
        iteration: i,
        trace,
        evaluation,
        durationMs: iterDuration,
      });

      // Check improvement
      const improvement = evaluation.overallScore - bestScore;
      if (improvement >= this.config.minImprovement) {
        bestTrace = trace;
        bestScore = evaluation.overallScore;
      } else if (improvement < 0) {
        // Regressed — keep the previous best
        break;
      }
    }

    // Extract answer if possible
    const answer = this.extractAnswer(bestTrace);

    return {
      problem,
      finalTrace: bestTrace,
      answer,
      answerCorrect: problem.expectedAnswer
        ? answer?.toLowerCase().includes(problem.expectedAnswer.toLowerCase())
        : undefined,
      history,
      totalIterations: history.length,
      qualityMet: bestScore >= this.config.qualityThreshold,
    };
  }

  /**
   * Run the pipeline on multiple problems.
   */
  async solveBatch(problems: ReasoningProblem[], concurrency = 3): Promise<ProblemResult[]> {
    const results: ProblemResult[] = [];
    const chunks: ReasoningProblem[][] = [];

    for (let i = 0; i < problems.length; i += concurrency) {
      chunks.push(problems.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(chunk.map((p) => this.solve(p)));
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Get statistics for a batch of results.
   */
  static stats(results: ProblemResult[]): {
    totalProblems: number;
    qualityMetCount: number;
    avgIterations: number;
    avgScore: number;
    answerAccuracy?: number;
  } {
    const qualityMetCount = results.filter((r) => r.qualityMet).length;
    const avgIterations = results.reduce((s, r) => s + r.totalIterations, 0) / results.length;
    const avgScore =
      results.reduce(
        (s, r) => s + (r.history[r.history.length - 1]?.evaluation.overallScore ?? 0),
        0,
      ) / results.length;

    const withAnswers = results.filter((r) => r.answerCorrect !== undefined);
    const answerAccuracy =
      withAnswers.length > 0
        ? withAnswers.filter((r) => r.answerCorrect).length / withAnswers.length
        : undefined;

    return {
      totalProblems: results.length,
      qualityMetCount,
      avgIterations,
      avgScore,
      answerAccuracy,
    };
  }

  private extractAnswer(trace: string): string | undefined {
    // Try to extract answer from common patterns
    const patterns = [
      /\*\*Answer\*\*:\s*(.+)/i,
      /Answer:\s*(.+)/i,
      /\*\*Final Answer\*\*:\s*(.+)/i,
      /Therefore,?\s*(.+)/i,
      /Thus,?\s*(.+)/i,
      /\*\*Result\*\*:\s*(.+)/i,
      /\\boxed\{(.+?)\}/,
    ];

    for (const pattern of patterns) {
      const match = trace.match(pattern);
      if (match) return match[1].trim();
    }

    // Return last line as fallback
    const lines = trace.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine.length < 200) return lastLine;
    }

    return undefined;
  }
}

// ─── Role-Playing Society ────────────────────────────────────────────────────

export interface RolePlayingConfig {
  /** The assistant agent's role name */
  assistantRoleName: string;
  /** The user/instructor agent's role name */
  userRoleName: string;
  /** The task to collaborate on */
  taskPrompt: string;
  /** LLM function */
  llm: (prompt: string) => Promise<string>;
  /** Number of conversation turns (default: 10) */
  maxTurns?: number;
  /** Whether to use task specification (default: true) */
  withTaskSpecify?: boolean;
  /** Whether to use a critic in the loop (default: false) */
  withCritic?: boolean;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  sender: string;
  content: string;
  turn: number;
}

export interface RolePlayingResult {
  task: string;
  specifiedTask?: string;
  messages: ConversationMessage[];
  finalResponse: string;
  totalTurns: number;
}

/**
 * Role-playing society: two agents collaborate on a task.
 * One agent plays the "user/instructor" and the other plays the "assistant".
 */
export class RolePlayingSociety {
  private config: RolePlayingConfig;

  constructor(config: RolePlayingConfig) {
    this.config = { maxTurns: 10, withTaskSpecify: true, withCritic: false, ...config };
  }

  /**
   * Run the role-playing conversation.
   */
  async run(): Promise<RolePlayingResult> {
    const messages: ConversationMessage[] = [];
    let task = this.config.taskPrompt;

    // Step 1: Task specification (make the task more specific)
    let specifiedTask: string | undefined;
    if (this.config.withTaskSpecify) {
      specifiedTask = await this.specifyTask(task);
      task = specifiedTask;
    }

    // Step 2: Generate system prompts
    const assistantSystemPrompt = this.generateAssistantPrompt(task);
    const userSystemPrompt = this.generateUserPrompt(task);

    // Step 3: Conversation loop
    let userMessage = `Please work on the following task: ${task}`;
    const maxTurns = this.config.maxTurns!;

    for (let turn = 0; turn < maxTurns; turn++) {
      // User turn
      const userContext =
        turn === 0
          ? userSystemPrompt
          : `${userSystemPrompt}\n\nPrevious conversation:\n${messages.map((m) => `${m.sender}: ${m.content}`).join("\n")}`;

      const userPrompt =
        turn === 0
          ? `${userContext}\n\n${userMessage}`
          : `Continue the conversation. Remember your role as ${this.config.userRoleName}.\n\n${userContext}`;

      const userResponse = await this.config.llm(userPrompt);
      messages.push({
        role: "user",
        sender: this.config.userRoleName,
        content: userResponse,
        turn,
      });

      // Assistant turn
      const assistantContext =
        turn === 0
          ? assistantSystemPrompt
          : `${assistantSystemPrompt}\n\nPrevious conversation:\n${messages.map((m) => `${m.sender}: ${m.content}`).join("\n")}`;

      const assistantPrompt = `${assistantContext}\n\n${this.config.userRoleName} says: ${userResponse}`;

      const assistantResponse = await this.config.llm(assistantPrompt);
      messages.push({
        role: "assistant",
        sender: this.config.assistantRoleName,
        content: assistantResponse,
        turn,
      });

      // Check if the task is complete
      if (
        assistantResponse.toLowerCase().includes("task complete") ||
        assistantResponse.toLowerCase().includes("here is the final") ||
        turn === maxTurns - 1
      ) {
        return {
          task,
          specifiedTask,
          messages,
          finalResponse: assistantResponse,
          totalTurns: turn + 1,
        };
      }

      userMessage = `Thank you. Please continue.`;
    }

    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();

    return {
      task,
      specifiedTask,
      messages,
      finalResponse: lastAssistant?.content ?? "",
      totalTurns: maxTurns,
    };
  }

  private async specifyTask(task: string): Promise<string> {
    const prompt = `Make the following task more specific and actionable. Add concrete details, constraints, and expected outcomes.

Original task: ${task}

Specific version:`;

    return this.config.llm(prompt);
  }

  private generateAssistantPrompt(task: string): string {
    return `You are ${this.config.assistantRoleName}. You are an expert assistant working on the following task.

Task: ${task}

Your role is to provide detailed, high-quality responses. Be thorough, creative, and helpful. When the task is complete, indicate that clearly.`;
  }

  private generateUserPrompt(task: string): string {
    return `You are ${this.config.userRoleName}. You are instructing an assistant to complete the following task.

Task: ${task}

Your role is to guide the assistant, provide clarifications, and ensure the task is completed correctly. Ask follow-up questions when needed.`;
  }
}

// ─── Critic Agent ────────────────────────────────────────────────────────────

export interface CriticConfig {
  /** LLM function */
  llm: (prompt: string) => Promise<string>;
  /** Evaluation criteria */
  criteria?: string;
}

export interface CriticEvaluation {
  score: number; // 0-1
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  detailedFeedback: string;
}

/**
 * Critic agent that evaluates candidate outputs and provides structured feedback.
 * Can be used in a tree-search loop to drive iterative improvement.
 */
export class CriticAgent {
  private config: CriticConfig;

  constructor(config: CriticConfig) {
    this.config = {
      criteria: "Evaluate the quality, accuracy, completeness, and clarity of the response.",
      ...config,
    };
  }

  /**
   * Evaluate a candidate output.
   */
  async evaluate(task: string, candidate: string): Promise<CriticEvaluation> {
    const prompt = `You are a critical evaluator. Your job is to carefully assess the quality of a response.

Task: ${task}

Response to evaluate:
${candidate}

Evaluation criteria: ${this.config.criteria}

Provide your evaluation in this exact JSON format:
{
  "score": <0.0-1.0>,
  "strengths": ["strength1", "strength2"],
  "weaknesses": ["weakness1", "weakness2"],
  "suggestions": ["suggestion1", "suggestion2"],
  "detailedFeedback": "<detailed evaluation text>"
}`;

    const response = await this.config.llm(prompt);
    return this.parseEvaluation(response);
  }

  /**
   * Compare multiple candidates and select the best.
   */
  async selectBest(
    task: string,
    candidates: string[],
  ): Promise<{ index: number; evaluation: CriticEvaluation }> {
    const evaluations = await Promise.all(candidates.map((c) => this.evaluate(task, c)));

    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < evaluations.length; i++) {
      if (evaluations[i].score > bestScore) {
        bestScore = evaluations[i].score;
        bestIdx = i;
      }
    }

    return { index: bestIdx, evaluation: evaluations[bestIdx] };
  }

  private parseEvaluation(text: string): CriticEvaluation {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: Math.max(0, Math.min(1, parsed.score ?? 0.5)),
          strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
          weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
          suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
          detailedFeedback: parsed.detailedFeedback ?? text,
        };
      }
    } catch {
      // Fall through
    }

    return {
      score: 0.5,
      strengths: [],
      weaknesses: [],
      suggestions: [],
      detailedFeedback: text,
    };
  }
}
