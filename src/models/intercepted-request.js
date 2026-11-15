import { EventEmitter } from 'node:events';
import { sendSSEResponse } from '../sse.js';

/**
 * Domain lifecycle status for an Intercepted Request.
 */
export const REQUEST_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RESOLVING: 'RESOLVING',
  RESOLVED: 'RESOLVED',
  CANCELED: 'CANCELED',
  ABORTED: 'ABORTED'
});

/**
 * InterceptedRequest encapsulates an incoming HTTP chat completion request
 * held in suspension until resolved, canceled, or aborted.
 */
export class InterceptedRequest extends EventEmitter {
  constructor(idOrOptions = {}, req, res, messages = [], tools = [], createdAt = Date.now()) {
    super();

    let id;
    if (typeof idOrOptions === 'object' && idOrOptions !== null && !(idOrOptions instanceof EventEmitter)) {
      ({
        id,
        req = req,
        res = res,
        messages = messages,
        tools = tools,
        createdAt = createdAt
      } = idOrOptions);
    } else {
      id = idOrOptions;
    }

    this.id = id || `req_${Date.now()}`;
    this.req = req;
    this.res = res;
    this.messages = Array.isArray(messages) ? messages : [];
    this.tools = Array.isArray(tools) ? tools : [];
    this.createdAt = createdAt || Date.now();
    this.status = REQUEST_STATUS.PENDING;

    if (this.req && typeof this.req.once === 'function') {
      this._onReqClose = () => {
        if (this.status === REQUEST_STATUS.PENDING) {
          this.abort();
        }
      };
      this.req.once('close', this._onReqClose);
    }
  }

  _cleanup() {
    if (this.req && typeof this.req.removeListener === 'function' && this._onReqClose) {
      this.req.removeListener('close', this._onReqClose);
      this._onReqClose = null;
    }
  }

  toJSON() {
    return {
      id: this.id,
      messages: this.messages,
      tools: this.tools,
      createdAt: this.createdAt,
      status: this.status
    };
  }

  resolve(payload) {
    if (this.status !== REQUEST_STATUS.PENDING) {
      throw new Error(`Cannot resolve request: current status is ${this.status}`);
    }

    const previousStatus = this.status;
    this.status = REQUEST_STATUS.RESOLVING;
    this.emit('stateChange', { status: this.status, previousStatus });

    if (this.res && !this.res.writableEnded) {
      sendSSEResponse(this.res, payload);
    }

    const resolvingStatus = this.status;
    this.status = REQUEST_STATUS.RESOLVED;
    this._cleanup();
    this.emit('resolved', { id: this.id, payload });
    this.emit('stateChange', { status: this.status, previousStatus: resolvingStatus });
  }

  cancel(reason = '\n[Task canceled by user via dashboard]') {
    if (this.status !== REQUEST_STATUS.PENDING) {
      throw new Error(`Cannot cancel request: current status is ${this.status}`);
    }

    const previousStatus = this.status;
    this.status = REQUEST_STATUS.CANCELED;
    this._cleanup();

    if (this.res && !this.res.writableEnded) {
      if (!this.res.headersSent) {
        this.res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
      }

      const cancelChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'agent-pipe',
        choices: [{
          index: 0,
          delta: { content: reason },
          finish_reason: 'stop'
        }]
      };

      this.res.write(`data: ${JSON.stringify(cancelChunk)}\n\n`);
      this.res.write('data: [DONE]\n\n');
      this.res.end();
    }

    this.emit('canceled', { id: this.id, reason });
    this.emit('stateChange', { status: this.status, previousStatus });
  }

  abort() {
    if (this.status !== REQUEST_STATUS.PENDING) {
      return;
    }

    const previousStatus = this.status;
    this.status = REQUEST_STATUS.ABORTED;
    this._cleanup();

    if (this.res && !this.res.destroyed && !this.res.writableEnded) {
      try {
        this.res.destroy();
      } catch {
        // Safe socket destroy
      }
    }

    this.emit('aborted', { id: this.id });
    this.emit('stateChange', { status: this.status, previousStatus });
  }
}

InterceptedRequest.STATUS = REQUEST_STATUS;

export default InterceptedRequest;
