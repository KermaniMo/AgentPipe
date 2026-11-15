import { InterceptedRequest, REQUEST_STATUS } from '../models/intercepted-request.js';
import { parseJsonBody } from '../router.js';
import defaultStore from '../store.js';

/**
 * Handles GET /v1/models and GET /models.
 * Returns an OpenAI-compatible model list response.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleModels(req, res) {
  const modelsResponse = {
    object: 'list',
    data: [
      {
        id: 'agent-relay',
        object: 'model'
      }
    ]
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(modelsResponse));
}

/**
 * Creates a route handler for POST /v1/chat/completions and POST /chat/completions.
 * Intercepts LLM completion calls from Agent Clients, extracts messages and tools,
 * instantiates an InterceptedRequest, and registers it in the RequestStore.
 * The HTTP connection is held open indefinitely until resolved, canceled, or aborted.
 *
 * @param {import('../store.js').RequestStore} [store]
 * @returns {Function} Request handler function (req, res)
 */
export function createChatCompletionsHandler(store = defaultStore) {
  return async function handleChatCompletions(req, res) {
    let body = req.body;
    if (body === undefined) {
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
        }
        return;
      }
    }

    if (!body || typeof body !== 'object') {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body: Expected an object' }));
      }
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const id = `req_${Date.now()}`;

    const interceptedRequest = new InterceptedRequest({
      id,
      req,
      res,
      messages,
      tools
    });

    // InterceptedRequest encapsulates client socket disconnect handling cooperatively,
    // transitioning to ABORTED and triggering store cleanup without duplicate event bindings.
    store.addRequest(interceptedRequest);
    // Indefinite Hold: Do NOT send response headers or call res.end().
  };
}

/**
 * Convenience handler for POST chat completions using the default store.
 */
export const handleChatCompletions = createChatCompletionsHandler(defaultStore);

/**
 * Registers Agent Client routes with the provided Router instance.
 *
 * @param {import('../router.js').Router|Function} router
 * @param {import('../store.js').RequestStore} [store]
 * @returns {import('../router.js').Router|Function}
 */
export function registerAgentRoutes(router, store = defaultStore) {
  const chatCompletionsHandler = createChatCompletionsHandler(store);

  router.get('/v1/models', handleModels);
  router.get('/models', handleModels);
  router.post('/v1/chat/completions', chatCompletionsHandler);
  router.post('/chat/completions', chatCompletionsHandler);

  return router;
}

/**
 * Creates an agent controller instance wrapping the handlers and store.
 *
 * @param {import('../store.js').RequestStore} [store]
 */
export function createAgentController(store = defaultStore) {
  return {
    handleModels,
    handleChatCompletions: createChatCompletionsHandler(store),
    registerRoutes(router) {
      return registerAgentRoutes(router, store);
    }
  };
}

export default {
  handleModels,
  createChatCompletionsHandler,
  handleChatCompletions,
  registerAgentRoutes,
  createAgentController
};
