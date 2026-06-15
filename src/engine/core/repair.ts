/**
 * Bounded self-repair around structured-output validation. Small local models
 * routinely emit JSON that fails the generation schema; rather than fail the
 * whole run on a single bad object, the structured-output steps (triage, the
 * planner) re-ask the same agent with the validation error appended, up to
 * `settings.structuredOutput.repairAttempts` extra times. The retry is a real
 * second model call, so it still reports usage (the billing seam sees it) and
 * is flagged `repaired` on its usage record.
 */
import { z } from 'zod';
import { limits } from '../../config/limits';

/**
 * Render a zod validation failure as a short, model-facing instruction: the
 * failing field paths and their messages, then an order to re-emit only the
 * corrected JSON. Kept compact because it rides back into a small local model's
 * prompt, where it must not crowd out the original request.
 */
export function repairInstruction(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return `Your previous response failed validation: ${issues}. Emit only the corrected JSON, with no commentary.`;
}

/**
 * Drive one bounded self-repair loop around `schema` validation. `attempt`
 * performs one model call and returns its raw output to validate; it receives
 * the repair instruction to fold into its prompt (and to flag its usage report
 * as a retry), or `undefined` on the first try. The raw output of each attempt
 * is validated with `safeParse`; on a failure the loop re-asks with the zod
 * issues appended, up to `settings.structuredOutput.repairAttempts` extra
 * times. When the last attempt also fails, its zod error is thrown, so the run
 * still dies with the same schema error - and the same Ollama hint - it did
 * before, only after the repair was tried.
 */
export async function parseWithRepair<T>(
  schema: z.ZodType<T>,
  attempt: (repair: string | undefined) => Promise<unknown>
): Promise<T> {
  const retries = Math.max(0, limits.structuredOutput.repairAttempts);
  let repair: string | undefined;
  for (let remaining = retries; ; remaining--) {
    const raw = await attempt(repair);
    const result = schema.safeParse(raw);
    if (result.success) {
      return result.data;
    }
    if (remaining === 0) {
      throw result.error;
    }
    repair = repairInstruction(result.error);
  }
}
