/**
 * The one normalisation for a prompt, shared by both sides of the boundary.
 *
 * A prompt set is edited in the browser and generated on the server, and **both have
 * to decide the same thing: whether two lines are the same question.** The run bills
 * per prompt and `promptsForQueuedRun` drops duplicates before posting, so two rows
 * that differ only by case, padding or a double space are a set that looks like it
 * has two questions and posts one — which reads as a bug and wastes the reader's
 * edit.
 *
 * It lives in `shared/` because the alternative is the rule written twice, once in
 * `promptSetGenerator` and once in the editor, with nothing to keep them in step —
 * the failure this repository has recorded most often.
 *
 * It is deliberately *not* a search-friendly normalisation (no stemming, no stop
 * words, no punctuation stripping): two questions that differ by a word are two
 * questions, and folding them together would drop a prompt the reader meant to ask.
 */
export function normalisePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}
