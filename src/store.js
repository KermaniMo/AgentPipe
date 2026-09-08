const pendingRequests = new Map();

export function addRequest(id, req, res, messages, tools = []) {
  pendingRequests.set(id, {
    id,
    req,
    res,
    messages,
    tools,
    createdAt: Date.now()
  });
}

export function getRequest(id) {
  return pendingRequests.get(id);
}

export function removeRequest(id) {
  return pendingRequests.delete(id);
}

export function getAllPending() {
  return Array.from(pendingRequests.values()).map(({ id, messages, tools, createdAt }) => ({
    id,
    messages,
    tools: tools || [],
    createdAt
  }));
}

export default {
  addRequest,
  getRequest,
  removeRequest,
  getAllPending
};
