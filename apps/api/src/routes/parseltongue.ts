// SPDX-License-Identifier: Apache-2.0
/**
 * Parseltongue routes — input obfuscation engine.
 *
 * POST /parseltongue/transform  — apply obfuscation to text
 * GET  /parseltongue/techniques — list available techniques + descriptions
 * GET  /parseltongue/triggers   — list default trigger word list
 *
 * @nexus/parseltongue detects trigger words likely to cause model refusals and
 * applies configurable obfuscation (leetspeak, unicode homoglyphs, ZWJ insertion,
 * mixedcase, phonetic substitution, random) so semantic meaning is preserved while
 * superficial pattern-matching fails.
 */

import {
  applyParseltongue,
  getDefaultConfig,
  getTechniqueDescription,
  DEFAULT_TRIGGERS,
  type ObfuscationTechnique,
  type ObfuscationIntensity,
  type ParseltongueConfig,
} from "@nexus/parseltongue";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

const TECHNIQUES: ObfuscationTechnique[] = [
  "leetspeak", "unicode", "zwj", "mixedcase", "phonetic", "random",
];

export async function parseltongueRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /parseltongue/transform
   *
   * Body:
   *   text            string   — input text to obfuscate
   *   technique?      string   — obfuscation technique (default: "unicode")
   *   intensity?      string   — "light" | "medium" | "heavy" (default: "medium")
   *   customTriggers? string[] — extra trigger words to detect (merged with defaults)
   *   enabled?        boolean  — false = return text unchanged (passthrough)
   *
   * Response: ParseltongueResult
   *   originalText, transformedText, triggersFound, techniqueUsed, transformations[]
   */
  app.post<{
    Body: {
      text:            string;
      technique?:      ObfuscationTechnique;
      intensity?:      ObfuscationIntensity;
      customTriggers?: string[];
      enabled?:        boolean;
    };
  }>(
    "/parseltongue/transform",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text:            { type: "string", minLength: 1, maxLength: 50_000 },
            technique:       { type: "string", enum: TECHNIQUES },
            intensity:       { type: "string", enum: ["light", "medium", "heavy"] },
            customTriggers:  { type: "array", items: { type: "string" } },
            enabled:         { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, technique, intensity, customTriggers = [], enabled = true } = request.body;

      const config: ParseltongueConfig = {
        enabled,
        technique:      technique   ?? getDefaultConfig().technique,
        intensity:      intensity   ?? getDefaultConfig().intensity,
        customTriggers: customTriggers,
      };

      const result = applyParseltongue(text, config);
      return reply.code(200).send(result);
    },
  );

  /**
   * GET /parseltongue/techniques
   *
   * Returns all available obfuscation techniques with human descriptions.
   */
  app.get(
    "/parseltongue/techniques",
    { preHandler: requireAuth },
    async (_request, reply) => {
      return reply.send({
        techniques: TECHNIQUES.map((t) => ({
          id:          t,
          description: getTechniqueDescription(t),
        })),
      });
    },
  );

  /**
   * GET /parseltongue/triggers
   *
   * Returns the built-in default trigger word list.
   */
  app.get(
    "/parseltongue/triggers",
    { preHandler: requireAuth },
    async (_request, reply) => {
      return reply.send({ triggers: [...DEFAULT_TRIGGERS], count: DEFAULT_TRIGGERS.length });
    },
  );
}
