// AI provider chain. A provider is:
//   { name: 'gemini',
//     available(env) -> boolean            // e.g. true only when its secret key exists
//     run({ message, callTool, env }) -> Promise<{ reply, mood, toolCalls? } | null> }
// If a provider returns null, throws, or times out, /chat quietly falls back to the scripted router.
//
// STATUS: no AI provider is implemented yet, so the chain is empty and every request uses the
// scripted router. A Gemini adapter is planned as the next step; it must be written against the
// current Gemini docs and tested with a real key before it is added here.
export function buildProviders(_env) {
  return [];
}
