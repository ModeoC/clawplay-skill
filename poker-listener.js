var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/eventsource-parser/dist/index.js
function noop(_arg) {
}
function createParser(callbacks) {
  if (typeof callbacks == "function")
    throw new TypeError(
      "`callbacks` must be an object, got a function instead. Did you mean `{onEvent: fn}`?"
    );
  const { onEvent = noop, onError = noop, onRetry = noop, onComment } = callbacks;
  let incompleteLine = "", isFirstChunk = true, id, data = "", eventType = "";
  function feed(newChunk) {
    const chunk = isFirstChunk ? newChunk.replace(/^\xEF\xBB\xBF/, "") : newChunk, [complete, incomplete] = splitLines(`${incompleteLine}${chunk}`);
    for (const line of complete)
      parseLine(line);
    incompleteLine = incomplete, isFirstChunk = false;
  }
  function parseLine(line) {
    if (line === "") {
      dispatchEvent();
      return;
    }
    if (line.startsWith(":")) {
      onComment && onComment(line.slice(line.startsWith(": ") ? 2 : 1));
      return;
    }
    const fieldSeparatorIndex = line.indexOf(":");
    if (fieldSeparatorIndex !== -1) {
      const field = line.slice(0, fieldSeparatorIndex), offset = line[fieldSeparatorIndex + 1] === " " ? 2 : 1, value = line.slice(fieldSeparatorIndex + offset);
      processField(field, value, line);
      return;
    }
    processField(line, "", line);
  }
  function processField(field, value, line) {
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data = `${data}${value}
`;
        break;
      case "id":
        id = value.includes("\0") ? void 0 : value;
        break;
      case "retry":
        /^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(
          new ParseError(`Invalid \`retry\` value: "${value}"`, {
            type: "invalid-retry",
            value,
            line
          })
        );
        break;
      default:
        onError(
          new ParseError(
            `Unknown field "${field.length > 20 ? `${field.slice(0, 20)}\u2026` : field}"`,
            { type: "unknown-field", field, value, line }
          )
        );
        break;
    }
  }
  function dispatchEvent() {
    data.length > 0 && onEvent({
      id,
      event: eventType || void 0,
      // If the data buffer's last character is a U+000A LINE FEED (LF) character,
      // then remove the last character from the data buffer.
      data: data.endsWith(`
`) ? data.slice(0, -1) : data
    }), id = void 0, data = "", eventType = "";
  }
  function reset(options = {}) {
    incompleteLine && options.consume && parseLine(incompleteLine), isFirstChunk = true, id = void 0, data = "", eventType = "", incompleteLine = "";
  }
  return { feed, reset };
}
function splitLines(chunk) {
  const lines = [];
  let incompleteLine = "", searchIndex = 0;
  for (; searchIndex < chunk.length; ) {
    const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
    let lineEnd = -1;
    if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = Math.min(crIndex, lfIndex) : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1) {
      incompleteLine = chunk.slice(searchIndex);
      break;
    } else {
      const line = chunk.slice(searchIndex, lineEnd);
      lines.push(line), searchIndex = lineEnd + 1, chunk[searchIndex - 1] === "\r" && chunk[searchIndex] === `
` && searchIndex++;
    }
  }
  return [lines, incompleteLine];
}
var ParseError;
var init_dist = __esm({
  "node_modules/eventsource-parser/dist/index.js"() {
    ParseError = class extends Error {
      constructor(message, options) {
        super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
      }
    };
  }
});

// node_modules/eventsource/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  ErrorEvent: () => ErrorEvent,
  EventSource: () => EventSource
});
function syntaxError(message) {
  const DomException = globalThis.DOMException;
  return typeof DomException == "function" ? new DomException(message, "SyntaxError") : new SyntaxError(message);
}
function flattenError(err) {
  return err instanceof Error ? "errors" in err && Array.isArray(err.errors) ? err.errors.map(flattenError).join(", ") : "cause" in err && err.cause instanceof Error ? `${err}: ${flattenError(err.cause)}` : err.message : `${err}`;
}
function inspectableError(err) {
  return {
    type: err.type,
    message: err.message,
    code: err.code,
    defaultPrevented: err.defaultPrevented,
    cancelable: err.cancelable,
    timeStamp: err.timeStamp
  };
}
function getBaseURL() {
  const doc = "document" in globalThis ? globalThis.document : void 0;
  return doc && typeof doc == "object" && "baseURI" in doc && typeof doc.baseURI == "string" ? doc.baseURI : void 0;
}
var ErrorEvent, __typeError, __accessCheck, __privateGet, __privateAdd, __privateSet, __privateMethod, _readyState, _url, _redirectUrl, _withCredentials, _fetch, _reconnectInterval, _reconnectTimer, _lastEventId, _controller, _parser, _onError, _onMessage, _onOpen, _EventSource_instances, connect_fn, _onFetchResponse, _onFetchError, getRequestOptions_fn, _onEvent, _onRetryChange, failConnection_fn, scheduleReconnect_fn, _reconnect, EventSource;
var init_dist2 = __esm({
  "node_modules/eventsource/dist/index.js"() {
    init_dist();
    ErrorEvent = class extends Event {
      /**
       * Constructs a new `ErrorEvent` instance. This is typically not called directly,
       * but rather emitted by the `EventSource` object when an error occurs.
       *
       * @param type - The type of the event (should be "error")
       * @param errorEventInitDict - Optional properties to include in the error event
       */
      constructor(type, errorEventInitDict) {
        var _a, _b;
        super(type), this.code = (_a = errorEventInitDict == null ? void 0 : errorEventInitDict.code) != null ? _a : void 0, this.message = (_b = errorEventInitDict == null ? void 0 : errorEventInitDict.message) != null ? _b : void 0;
      }
      /**
       * Node.js "hides" the `message` and `code` properties of the `ErrorEvent` instance,
       * when it is `console.log`'ed. This makes it harder to debug errors. To ease debugging,
       * we explicitly include the properties in the `inspect` method.
       *
       * This is automatically called by Node.js when you `console.log` an instance of this class.
       *
       * @param _depth - The current depth
       * @param options - The options passed to `util.inspect`
       * @param inspect - The inspect function to use (prevents having to import it from `util`)
       * @returns A string representation of the error
       */
      [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")](_depth, options, inspect) {
        return inspect(inspectableError(this), options);
      }
      /**
       * Deno "hides" the `message` and `code` properties of the `ErrorEvent` instance,
       * when it is `console.log`'ed. This makes it harder to debug errors. To ease debugging,
       * we explicitly include the properties in the `inspect` method.
       *
       * This is automatically called by Deno when you `console.log` an instance of this class.
       *
       * @param inspect - The inspect function to use (prevents having to import it from `util`)
       * @param options - The options passed to `Deno.inspect`
       * @returns A string representation of the error
       */
      [/* @__PURE__ */ Symbol.for("Deno.customInspect")](inspect, options) {
        return inspect(inspectableError(this), options);
      }
    };
    __typeError = (msg) => {
      throw TypeError(msg);
    };
    __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
    __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
    __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
    __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
    __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
    EventSource = class extends EventTarget {
      constructor(url, eventSourceInitDict) {
        var _a, _b;
        super(), __privateAdd(this, _EventSource_instances), this.CONNECTING = 0, this.OPEN = 1, this.CLOSED = 2, __privateAdd(this, _readyState), __privateAdd(this, _url), __privateAdd(this, _redirectUrl), __privateAdd(this, _withCredentials), __privateAdd(this, _fetch), __privateAdd(this, _reconnectInterval), __privateAdd(this, _reconnectTimer), __privateAdd(this, _lastEventId, null), __privateAdd(this, _controller), __privateAdd(this, _parser), __privateAdd(this, _onError, null), __privateAdd(this, _onMessage, null), __privateAdd(this, _onOpen, null), __privateAdd(this, _onFetchResponse, async (response) => {
          var _a2;
          __privateGet(this, _parser).reset();
          const { body, redirected, status, headers } = response;
          if (status === 204) {
            __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, "Server sent HTTP 204, not reconnecting", 204), this.close();
            return;
          }
          if (redirected ? __privateSet(this, _redirectUrl, new URL(response.url)) : __privateSet(this, _redirectUrl, void 0), status !== 200) {
            __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, `Non-200 status code (${status})`, status);
            return;
          }
          if (!(headers.get("content-type") || "").startsWith("text/event-stream")) {
            __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, 'Invalid content type, expected "text/event-stream"', status);
            return;
          }
          if (__privateGet(this, _readyState) === this.CLOSED)
            return;
          __privateSet(this, _readyState, this.OPEN);
          const openEvent = new Event("open");
          if ((_a2 = __privateGet(this, _onOpen)) == null || _a2.call(this, openEvent), this.dispatchEvent(openEvent), typeof body != "object" || !body || !("getReader" in body)) {
            __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, "Invalid response body, expected a web ReadableStream", status), this.close();
            return;
          }
          const decoder = new TextDecoder(), reader = body.getReader();
          let open = true;
          do {
            const { done, value } = await reader.read();
            value && __privateGet(this, _parser).feed(decoder.decode(value, { stream: !done })), done && (open = false, __privateGet(this, _parser).reset(), __privateMethod(this, _EventSource_instances, scheduleReconnect_fn).call(this));
          } while (open);
        }), __privateAdd(this, _onFetchError, (err) => {
          __privateSet(this, _controller, void 0), !(err.name === "AbortError" || err.type === "aborted") && __privateMethod(this, _EventSource_instances, scheduleReconnect_fn).call(this, flattenError(err));
        }), __privateAdd(this, _onEvent, (event) => {
          typeof event.id == "string" && __privateSet(this, _lastEventId, event.id);
          const messageEvent = new MessageEvent(event.event || "message", {
            data: event.data,
            origin: __privateGet(this, _redirectUrl) ? __privateGet(this, _redirectUrl).origin : __privateGet(this, _url).origin,
            lastEventId: event.id || ""
          });
          __privateGet(this, _onMessage) && (!event.event || event.event === "message") && __privateGet(this, _onMessage).call(this, messageEvent), this.dispatchEvent(messageEvent);
        }), __privateAdd(this, _onRetryChange, (value) => {
          __privateSet(this, _reconnectInterval, value);
        }), __privateAdd(this, _reconnect, () => {
          __privateSet(this, _reconnectTimer, void 0), __privateGet(this, _readyState) === this.CONNECTING && __privateMethod(this, _EventSource_instances, connect_fn).call(this);
        });
        try {
          if (url instanceof URL)
            __privateSet(this, _url, url);
          else if (typeof url == "string")
            __privateSet(this, _url, new URL(url, getBaseURL()));
          else
            throw new Error("Invalid URL");
        } catch {
          throw syntaxError("An invalid or illegal string was specified");
        }
        __privateSet(this, _parser, createParser({
          onEvent: __privateGet(this, _onEvent),
          onRetry: __privateGet(this, _onRetryChange)
        })), __privateSet(this, _readyState, this.CONNECTING), __privateSet(this, _reconnectInterval, 3e3), __privateSet(this, _fetch, (_a = eventSourceInitDict == null ? void 0 : eventSourceInitDict.fetch) != null ? _a : globalThis.fetch), __privateSet(this, _withCredentials, (_b = eventSourceInitDict == null ? void 0 : eventSourceInitDict.withCredentials) != null ? _b : false), __privateMethod(this, _EventSource_instances, connect_fn).call(this);
      }
      /**
       * Returns the state of this EventSource object's connection. It can have the values described below.
       *
       * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/readyState)
       *
       * Note: typed as `number` instead of `0 | 1 | 2` for compatibility with the `EventSource` interface,
       * defined in the TypeScript `dom` library.
       *
       * @public
       */
      get readyState() {
        return __privateGet(this, _readyState);
      }
      /**
       * Returns the URL providing the event stream.
       *
       * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/url)
       *
       * @public
       */
      get url() {
        return __privateGet(this, _url).href;
      }
      /**
       * Returns true if the credentials mode for connection requests to the URL providing the event stream is set to "include", and false otherwise.
       *
       * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/withCredentials)
       */
      get withCredentials() {
        return __privateGet(this, _withCredentials);
      }
      /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/error_event) */
      get onerror() {
        return __privateGet(this, _onError);
      }
      set onerror(value) {
        __privateSet(this, _onError, value);
      }
      /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/message_event) */
      get onmessage() {
        return __privateGet(this, _onMessage);
      }
      set onmessage(value) {
        __privateSet(this, _onMessage, value);
      }
      /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/open_event) */
      get onopen() {
        return __privateGet(this, _onOpen);
      }
      set onopen(value) {
        __privateSet(this, _onOpen, value);
      }
      addEventListener(type, listener, options) {
        const listen = listener;
        super.addEventListener(type, listen, options);
      }
      removeEventListener(type, listener, options) {
        const listen = listener;
        super.removeEventListener(type, listen, options);
      }
      /**
       * Aborts any instances of the fetch algorithm started for this EventSource object, and sets the readyState attribute to CLOSED.
       *
       * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/close)
       *
       * @public
       */
      close() {
        __privateGet(this, _reconnectTimer) && clearTimeout(__privateGet(this, _reconnectTimer)), __privateGet(this, _readyState) !== this.CLOSED && (__privateGet(this, _controller) && __privateGet(this, _controller).abort(), __privateSet(this, _readyState, this.CLOSED), __privateSet(this, _controller, void 0));
      }
    };
    _readyState = /* @__PURE__ */ new WeakMap(), _url = /* @__PURE__ */ new WeakMap(), _redirectUrl = /* @__PURE__ */ new WeakMap(), _withCredentials = /* @__PURE__ */ new WeakMap(), _fetch = /* @__PURE__ */ new WeakMap(), _reconnectInterval = /* @__PURE__ */ new WeakMap(), _reconnectTimer = /* @__PURE__ */ new WeakMap(), _lastEventId = /* @__PURE__ */ new WeakMap(), _controller = /* @__PURE__ */ new WeakMap(), _parser = /* @__PURE__ */ new WeakMap(), _onError = /* @__PURE__ */ new WeakMap(), _onMessage = /* @__PURE__ */ new WeakMap(), _onOpen = /* @__PURE__ */ new WeakMap(), _EventSource_instances = /* @__PURE__ */ new WeakSet(), /**
    * Connect to the given URL and start receiving events
    *
    * @internal
    */
    connect_fn = function() {
      __privateSet(this, _readyState, this.CONNECTING), __privateSet(this, _controller, new AbortController()), __privateGet(this, _fetch)(__privateGet(this, _url), __privateMethod(this, _EventSource_instances, getRequestOptions_fn).call(this)).then(__privateGet(this, _onFetchResponse)).catch(__privateGet(this, _onFetchError));
    }, _onFetchResponse = /* @__PURE__ */ new WeakMap(), _onFetchError = /* @__PURE__ */ new WeakMap(), /**
    * Get request options for the `fetch()` request
    *
    * @returns The request options
    * @internal
    */
    getRequestOptions_fn = function() {
      var _a;
      const init = {
        // [spec] Let `corsAttributeState` be `Anonymous`…
        // [spec] …will have their mode set to "cors"…
        mode: "cors",
        redirect: "follow",
        headers: { Accept: "text/event-stream", ...__privateGet(this, _lastEventId) ? { "Last-Event-ID": __privateGet(this, _lastEventId) } : void 0 },
        cache: "no-store",
        signal: (_a = __privateGet(this, _controller)) == null ? void 0 : _a.signal
      };
      return "window" in globalThis && (init.credentials = this.withCredentials ? "include" : "same-origin"), init;
    }, _onEvent = /* @__PURE__ */ new WeakMap(), _onRetryChange = /* @__PURE__ */ new WeakMap(), /**
    * Handles the process referred to in the EventSource specification as "failing a connection".
    *
    * @param error - The error causing the connection to fail
    * @param code - The HTTP status code, if available
    * @internal
    */
    failConnection_fn = function(message, code) {
      var _a;
      __privateGet(this, _readyState) !== this.CLOSED && __privateSet(this, _readyState, this.CLOSED);
      const errorEvent = new ErrorEvent("error", { code, message });
      (_a = __privateGet(this, _onError)) == null || _a.call(this, errorEvent), this.dispatchEvent(errorEvent);
    }, /**
    * Schedules a reconnection attempt against the EventSource endpoint.
    *
    * @param message - The error causing the connection to fail
    * @param code - The HTTP status code, if available
    * @internal
    */
    scheduleReconnect_fn = function(message, code) {
      var _a;
      if (__privateGet(this, _readyState) === this.CLOSED)
        return;
      __privateSet(this, _readyState, this.CONNECTING);
      const errorEvent = new ErrorEvent("error", { code, message });
      (_a = __privateGet(this, _onError)) == null || _a.call(this, errorEvent), this.dispatchEvent(errorEvent), __privateSet(this, _reconnectTimer, setTimeout(__privateGet(this, _reconnect), __privateGet(this, _reconnectInterval)));
    }, _reconnect = /* @__PURE__ */ new WeakMap(), /**
    * ReadyState representing an EventSource currently trying to connect
    *
    * @public
    */
    EventSource.CONNECTING = 0, /**
    * ReadyState representing an EventSource connection that is open (eg connected)
    *
    * @public
    */
    EventSource.OPEN = 1, /**
    * ReadyState representing an EventSource connection that is closed (eg disconnected)
    *
    * @public
    */
    EventSource.CLOSED = 2;
  }
});

// poker-listener.ts
import { execFile } from "node:child_process";
import { readFileSync as readFileSync3, writeFileSync, unlinkSync, createWriteStream } from "node:fs";
import { join as join3 } from "node:path";

// card-format.ts
var SUIT_MAP = { s: "\u2660", h: "\u2665", d: "\u2666", c: "\u2663" };
function formatCard(card) {
  if (card.length !== 2) return card;
  const rank = card[0];
  const suit = SUIT_MAP[card[1]];
  if (!suit) return card;
  return rank + suit;
}
function formatCards(cards) {
  return cards.map(formatCard).join(" ");
}

// state-differ.ts
function diffStates(prev, next) {
  const events = [];
  const hdr = `**[Hand #${next.handNumber}]**`;
  if (!prev || prev.handNumber !== next.handNumber) {
    if (next.yourCards && next.yourCards.length > 0) {
      const cards = formatCards(next.yourCards);
      const me = next.players?.find((p) => p.seat === next.yourSeat);
      const stack = me?.chips ?? next.yourChips;
      events.push(`${hdr} Your cards: ${cards} \xB7 Stack: ${stack}`);
    }
    return events;
  }
  const prevPlayerMap = new Map(prev.players.map((p) => [p.seat, p]));
  for (const nextPlayer of next.players) {
    if (nextPlayer.seat === next.yourSeat) continue;
    const prevPlayer = prevPlayerMap.get(nextPlayer.seat);
    if (!prevPlayer) {
      events.push(`${hdr} ${nextPlayer.name} joined the table (${nextPlayer.chips} chips)`);
      continue;
    }
    if (prevPlayer.status !== "all_in" && nextPlayer.status === "all_in") {
      events.push(`${hdr} ${nextPlayer.name} went all-in (${nextPlayer.invested} invested \xB7 ${nextPlayer.chips} behind)`);
      continue;
    }
    if (prevPlayer.status !== "folded" && nextPlayer.status === "folded") {
      events.push(`${hdr} ${nextPlayer.name} folded`);
      continue;
    }
    if (nextPlayer.bet > prevPlayer.bet) {
      const betAmount = nextPlayer.bet;
      const chipInfo = ` (${nextPlayer.invested} invested \xB7 ${nextPlayer.chips} behind)`;
      const actionType = nextPlayer.lastAction?.type;
      if (actionType === "raise") {
        events.push(`${hdr} ${nextPlayer.name} raised to ${betAmount}${chipInfo}`);
      } else if (actionType === "bet") {
        events.push(`${hdr} ${nextPlayer.name} bet ${betAmount}${chipInfo}`);
      } else {
        events.push(`${hdr} ${nextPlayer.name} called ${betAmount}${chipInfo}`);
      }
      continue;
    }
    if (prevPlayer.isCurrentActor && !nextPlayer.isCurrentActor && nextPlayer.lastAction?.type === "check") {
      events.push(`${hdr} ${nextPlayer.name} checked`);
      continue;
    }
  }
  const nextPlayerSeats = new Set(next.players.map((p) => p.seat));
  for (const prevPlayer of prev.players) {
    if (prevPlayer.seat === next.yourSeat) continue;
    if (!nextPlayerSeats.has(prevPlayer.seat)) {
      events.push(`${hdr} ${prevPlayer.name} left the table`);
    }
  }
  const prevBoardLen = prev.boardCards.length;
  const nextBoardLen = next.boardCards.length;
  if (prevBoardLen === 0 && nextBoardLen >= 3) {
    const flopCards = formatCards(next.boardCards.slice(0, 3));
    events.push(`${hdr} Flop: ${flopCards} | Pot: ${next.pot}`);
  }
  if (prevBoardLen <= 3 && nextBoardLen >= 4 && prevBoardLen < nextBoardLen) {
    if (prevBoardLen === 3) {
      const turnCard = formatCard(next.boardCards[3]);
      const board = formatCards(next.boardCards.slice(0, 4));
      events.push(`${hdr} Turn: ${turnCard} \u2192 ${board} | Pot: ${next.pot}`);
    }
  }
  if (prevBoardLen <= 4 && nextBoardLen >= 5 && prevBoardLen < nextBoardLen) {
    if (prevBoardLen === 4) {
      const riverCard = formatCard(next.boardCards[4]);
      const board = formatCards(next.boardCards);
      events.push(`${hdr} River: ${riverCard} \u2192 ${board} | Pot: ${next.pot}`);
    }
  }
  return events;
}

// review.ts
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
var __dirname = dirname(process.argv[1]);
var SKILL_ROOT = __dirname.endsWith(sep + "dist") || __dirname.endsWith(sep + "build") ? join(__dirname, "..") : __dirname;
var PLAYBOOK_FILE = join(SKILL_ROOT, "poker-playbook.md");
function readClawPlayConfig() {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "clawplay-config.json"), "utf8");
    const parsed = JSON.parse(raw);
    const config = {};
    if (typeof parsed.apiKeyEnvVar === "string" && parsed.apiKeyEnvVar) config.apiKeyEnvVar = parsed.apiKeyEnvVar;
    if (typeof parsed.accountId === "string" && parsed.accountId) config.accountId = parsed.accountId;
    if (typeof parsed.agentId === "string" && parsed.agentId) config.agentId = parsed.agentId;
    return config;
  } catch {
    return {};
  }
}
function resolveApiKey(config) {
  if (config.apiKeyEnvVar) return process.env[config.apiKeyEnvVar] || void 0;
  return process.env.CLAWPLAY_API_KEY_PRIMARY || void 0;
}
function readPlaybook() {
  try {
    return readFileSync(PLAYBOOK_FILE, "utf8").trim();
  } catch {
    return "";
  }
}
function readNotes() {
  try {
    return readFileSync(join(SKILL_ROOT, "poker-notes.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

// prompts.ts
var WARMUP_MESSAGE = "(system: session warmup \u2014 no action needed)";
var controlSignals = {
  decisionTimedOut: () => `[POKER CONTROL SIGNAL: DECISION_STATUS] Timed out \u2014 the hand moved on before I could decide.`,
  decisionAutoFolded: () => `[POKER CONTROL SIGNAL: DECISION_STATUS] Decision timed out \u2014 auto-folded.`,
  decisionStaleHand: (action) => `[POKER CONTROL SIGNAL: DECISION_STATUS] Hand moved on while deciding \u2014 skipped ${action}.`,
  actionRejected: (status, reason) => `[POKER CONTROL SIGNAL: DECISION_STATUS] Action rejected (${status}): ${reason}`,
  actionRejectedNoReason: (status) => `[POKER CONTROL SIGNAL: DECISION_STATUS] Action rejected (${status}) \u2014 could not read reason.`,
  gameOver: (gameId, reason, finalStack) => `[POKER CONTROL SIGNAL: GAME_OVER] Game ended on table ${gameId}. Reason: ${reason}. Final stack: ${finalStack}. Run post-game review per SKILL.md instructions.`,
  connectionError: (gameId, reason, finalStack) => `[POKER CONTROL SIGNAL: CONNECTION_ERROR] Lost connection to table ${gameId}. Reason: ${reason}. Last known stack: ${finalStack}. Offer to check status or reconnect.`,
  handUpdate: (msg) => `[POKER CONTROL SIGNAL: HAND_UPDATE] ${msg}`,
  waitingForPlayers: (gameId) => `[POKER CONTROL SIGNAL: WAITING_FOR_PLAYERS] All opponents left table ${gameId}. Run prompt to get buttons and send them with your message using the message tool. Your turn ends after sending.`,
  rebuyAvailable: (gameId, amount) => `[POKER CONTROL SIGNAL: REBUY_AVAILABLE] Busted on table ${gameId}. Rebuy available for ${amount} chips. Run prompt to get buttons and send them with your message using the message tool. Your turn ends after sending.`,
  decisionFailureExit: (count) => `[POKER CONTROL SIGNAL: DECISION_STATUS] ${count} consecutive decisions failed (timeout/error) \u2014 listener exiting. The game session may have a file lock or routing issue. Tell the user something went wrong with your decision-making and you had to leave the table.`
};
function buildSummary(view) {
  const cards = view.yourCards?.length ? formatCards(view.yourCards) : "??";
  const board = view.boardCards?.length ? formatCards(view.boardCards) : "";
  const phase = view.phase;
  const pot = view.pot;
  const stack = view.yourChips;
  const active = view.players?.filter((p) => p.status === "active").length || 0;
  const actions = (view.availableActions || []).map((a) => {
    if (a.type === "fold" || a.type === "check" || a.type === "call") return a.amount ? `${a.type} ${a.amount}` : a.type;
    if (a.minAmount != null) return `${a.type} ${a.minAmount}-${a.maxAmount}`;
    return a.type;
  }).join(", ");
  return board ? `${phase} | Board: ${board} | ${cards} | Pot:${pot} | Stack:${stack} | ${active} active | Actions: ${actions}` : `${phase} | ${cards} | Pot:${pot} | Stack:${stack} | ${active} active | Actions: ${actions}`;
}
function buildHandResultSummary(state, handNumber) {
  const result = state.lastHandResult;
  const hdr = handNumber ? `**[Hand #${handNumber}]**` : "";
  if (!result) return null;
  const winners = result.players?.filter((p) => result.winners?.includes(p.seat)).map((p) => p.name) || [];
  const pot = result.potResults?.[0]?.amount || 0;
  const myStack = result.players?.find((p) => p.seat === state.yourSeat)?.chips || state.yourChips;
  return `${hdr} ${winners.join(", ")} won ${pot}. Stack: ${myStack}.`;
}
function formatRecentHand(hand) {
  const num = hand.handNumber;
  const outcome = hand.yourOutcome;
  if (!outcome) return `#${num}: (no outcome data)`;
  const winnerNames = hand.result.winners.map((w) => w.name).join(", ");
  const pot = hand.result.potSize;
  const board = hand.boardCards.length > 0 ? formatCards(hand.boardCards) : "";
  if (outcome.action === "folded") {
    const phase = outcome.phase ? ` on ${outcome.phase.toLowerCase()}` : " preflop";
    return `#${num}: You folded${phase}. ${winnerNames} won ${pot}${pot <= hand.result.potSize * 0.5 ? " uncontested" : ""}.`;
  }
  if (outcome.action === "won") {
    const showdownHands = hand.result.showdownHands;
    if (showdownHands && showdownHands.length > 0) {
      const myHand2 = outcome.holeCards ? formatCards(outcome.holeCards) : "??";
      const ranking2 = outcome.handRanking || "unknown";
      const losers = showdownHands.filter((sh) => !hand.result.winners.some((w) => w.name === sh.name)).map((sh) => `${sh.name}: ${formatCards(sh.holeCards)} (${sh.handRanking || "?"})`).join(", ");
      return `#${num}: Showdown \u2014 You won ${pot} with ${myHand2} (${ranking2}).${losers ? ` ${losers} lost.` : ""} Board: ${board}`;
    }
    return `#${num}: You won ${pot} uncontested.`;
  }
  const myHand = outcome.holeCards ? formatCards(outcome.holeCards) : "??";
  const ranking = outcome.handRanking || "unknown";
  const invested = outcome.invested ?? 0;
  const showdownWinner = hand.result.showdownHands?.find((sh) => hand.result.winners.some((w) => w.name === sh.name));
  const winnerInfo = showdownWinner ? `${winnerNames} won ${pot} with ${formatCards(showdownWinner.holeCards)} (${showdownWinner.handRanking || "?"}). ` : `${winnerNames} won ${pot}. `;
  return `#${num}: Showdown \u2014 ${winnerInfo}You lost ${invested} with ${myHand} (${ranking}). Board: ${board}`;
}
function formatOpponentStats(stats) {
  const lines = [];
  for (const [name, s] of Object.entries(stats)) {
    const archetype = s.handsPlayed < 10 ? "(small sample)" : `${s.vpip >= 30 ? "Loose" : "Tight"}-${s.af >= 1.2 ? "aggressive" : "passive"}`;
    lines.push(
      `${name} (${s.handsPlayed} hands): VPIP ${s.vpip}% \xB7 PFR ${s.pfr}% \xB7 3-bet ${s.threeBet}% \xB7 AF ${s.af} \xB7 Fold-to-raise ${s.foldToRaise}%
\u2192 ${archetype}`
    );
  }
  return lines;
}
function buildDecisionPrompt(summary, playbook, handEvents, recentHandLines, opponentStatsLines, sessionInsights, notes = "", handNotes = "") {
  const playbookSection = playbook || "You are a skilled poker player. Play intelligently and mix your play.";
  const handActionSection = handEvents.length > 0 ? `
\u2550\u2550\u2550 THIS HAND \u2550\u2550\u2550
${handEvents.join("\n")}
` : "";
  const opponentSection = opponentStatsLines.length > 0 ? `
\u2550\u2550\u2550 OPPONENT PROFILE \u2550\u2550\u2550
${opponentStatsLines.join("\n\n")}
` : "";
  const insightsSection = sessionInsights ? `
\u2550\u2550\u2550 SESSION INSIGHTS \u2550\u2550\u2550
${sessionInsights}
` : "";
  const recentHandsSection = recentHandLines.length > 0 ? `
\u2550\u2550\u2550 RECENT HANDS (last ${recentHandLines.length}) \u2550\u2550\u2550
${recentHandLines.join("\n")}
` : "";
  const notesParts = [];
  if (notes) notesParts.push(`Session notes:
${notes}`);
  if (handNotes) notesParts.push(`THIS HAND ONLY:
${handNotes}`);
  const notesSection = notesParts.length > 0 ? `
Tactical notes from your human partner:
${notesParts.join("\n\n")}
` : "";
  return `You are playing No-Limit Hold'em poker. It is your turn to act.

${playbookSection}

\u2550\u2550\u2550 SITUATION \u2550\u2550\u2550
${summary}
${handActionSection}${opponentSection}${insightsSection}${recentHandsSection}${notesSection}
Play your best poker. Trust your judgment on hand strength, position, pot odds, and opponent tendencies. If raising, your amount MUST be within the range shown in Actions (e.g., 'raise 40-970' means amount between 40 and 970).

Respond with ONLY a JSON object, no other text:
{"action": "fold|check|call|raise|all_in", "amount": <number if raise/bet, omit otherwise>, "narration": "<one sentence: what you did and why, in your own voice>"}`;
}
function buildReflectionPrompt(opponentStatsLines, recentHandLines, currentInsights) {
  const parts = [
    "You are between hands in a poker session. Review the session so far and update your running insights."
  ];
  if (opponentStatsLines.length > 0) {
    parts.push(`
\u2550\u2550\u2550 OPPONENT PROFILE \u2550\u2550\u2550
${opponentStatsLines.join("\n\n")}`);
  }
  if (recentHandLines.length > 0) {
    parts.push(`
\u2550\u2550\u2550 RECENT HANDS (last ${recentHandLines.length}) \u2550\u2550\u2550
${recentHandLines.join("\n")}`);
  }
  parts.push(`
\u2550\u2550\u2550 CURRENT SESSION INSIGHTS \u2550\u2550\u2550
${currentInsights}`);
  parts.push(
    "\nUpdate your session insights. Cover: opponent tendencies THIS SESSION, your strategy adjustments, stack management observations. 2-3 sentences. If nothing meaningful changed, return the same insights unchanged.",
    '\nRespond with ONLY JSON: {"insights": "..."}'
  );
  return parts.join("\n");
}

// gateway-client.ts
import { randomUUID } from "node:crypto";
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var PROTOCOL_VERSION = 3;
function resolveGatewayToken() {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const home = process.env.HOME || "/root";
    const cfg = JSON.parse(readFileSync2(join2(home, ".openclaw", "openclaw.json"), "utf8"));
    const token = cfg?.gateway?.auth?.token;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {
  }
  return void 0;
}
function resolveGatewayUrl() {
  try {
    const home = process.env.HOME || "/root";
    const cfg = JSON.parse(readFileSync2(join2(home, ".openclaw", "openclaw.json"), "utf8"));
    const port = cfg?.gateway?.port || 18789;
    return `ws://127.0.0.1:${port}`;
  } catch {
    return "ws://127.0.0.1:18789";
  }
}
var GatewayWsClient = class {
  ws = null;
  pending = /* @__PURE__ */ new Map();
  token;
  url;
  connected = false;
  closed = false;
  connectPromise = null;
  connectResolve = null;
  connectReject = null;
  reconnectTimer = null;
  backoffMs = 1e3;
  wasEverConnected = false;
  nonce = null;
  challengeTimer = null;
  emitFn = null;
  constructor(opts) {
    this.token = resolveGatewayToken();
    this.url = resolveGatewayUrl();
    this.emitFn = opts?.emit ?? null;
  }
  /** Connect to the gateway and complete the auth handshake. */
  async connect() {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.startConnection();
    });
    return this.connectPromise;
  }
  startConnection() {
    if (this.closed) return;
    this.nonce = null;
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connectReject?.(new Error(`WebSocket create failed: ${msg}`));
      return;
    }
    this.challengeTimer = setTimeout(() => {
      this.challengeTimer = null;
      if (!this.connected) {
        this.ws?.close();
        this.connectReject?.(new Error("Gateway connect challenge timeout"));
      }
    }, 5e3);
    this.ws.onopen = () => {
      this.backoffMs = 1e3;
      this.emit({ type: "GW_WS_OPEN" });
    };
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        this.handleMessage(msg);
      } catch {
      }
    };
    this.ws.onclose = () => {
      if (this.challengeTimer) {
        clearTimeout(this.challengeTimer);
        this.challengeTimer = null;
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      this.flushPending(new Error("Gateway connection closed"));
      if (!this.closed && (wasConnected || this.wasEverConnected)) {
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        this.scheduleReconnect();
      } else if (!wasConnected) {
        this.connectReject?.(new Error("Gateway connection closed before auth"));
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
      }
    };
    this.ws.onerror = () => {
    };
  }
  handleMessage(msg) {
    if (msg.type === "event") {
      if (msg.event === "connect.challenge") {
        const payload = msg.payload;
        this.nonce = payload?.nonce?.toString().trim() ?? null;
        if (this.nonce) this.sendConnectRequest();
      }
      return;
    }
    if (msg.type === "res") {
      const id = msg.id;
      const pending = this.pending.get(id);
      if (!pending) return;
      const payload = msg.payload;
      if (pending.expectFinal && payload?.status === "accepted") return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve(payload);
      } else {
        const errMsg = msg.error?.message ?? "Unknown gateway error";
        pending.reject(new Error(errMsg));
      }
    }
  }
  sendConnectRequest() {
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: process.platform,
        mode: "backend"
      },
      caps: [],
      role: "operator",
      scopes: ["operator.admin"]
    };
    if (this.token) {
      params.auth = { token: this.token };
    }
    this.request("connect", params, { timeoutMs: 5e3 }).then(() => {
      this.connected = true;
      this.wasEverConnected = true;
      if (this.challengeTimer) {
        clearTimeout(this.challengeTimer);
        this.challengeTimer = null;
      }
      this.connectResolve?.();
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
      this.emit({ type: "GW_CONNECTED" });
    }).catch((err) => {
      this.connectReject?.(err);
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
      this.ws?.close();
    });
  }
  /** Send an RPC request to the gateway. */
  request(method, params, opts) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Gateway not connected"));
        return;
      }
      const id = randomUUID();
      const timeoutMs = opts?.timeoutMs ?? 3e4;
      const expectFinal = opts?.expectFinal ?? false;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, expectFinal, timer });
      const frame = { type: "req", id, method, params };
      this.ws.send(JSON.stringify(frame));
    });
  }
  /** Call the agent RPC method. Handles two-phase response. */
  async callAgent(params, timeoutMs = 6e4) {
    if (!this.connected) await this.connect();
    const rpcParams = {
      message: params.message,
      idempotencyKey: params.idempotencyKey ?? randomUUID()
    };
    if (params.agentId) rpcParams.agentId = params.agentId;
    if (params.sessionKey) rpcParams.sessionKey = params.sessionKey;
    if (params.sessionId) rpcParams.sessionId = params.sessionId;
    if (params.thinking) rpcParams.thinking = params.thinking;
    if (params.timeout != null) rpcParams.timeout = params.timeout;
    const result = await this.request("agent", rpcParams, {
      timeoutMs,
      expectFinal: true
    });
    return result?.result ?? { payloads: [] };
  }
  /** Disconnect and stop reconnecting. */
  stop() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("Gateway client stopped"));
  }
  scheduleReconnect() {
    if (this.closed) return;
    this.emit({ type: "GW_RECONNECT", delayMs: this.backoffMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPromise = new Promise((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
        this.startConnection();
      });
      this.connectPromise.catch(() => {
      });
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 3e4);
  }
  flushPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
  emit(obj) {
    this.emitFn?.(obj);
  }
};

// poker-listener.ts
var ACTIVE_PHASES = /* @__PURE__ */ new Set(["PREFLOP", "FLOP", "TURN", "RIVER"]);
var debugStream = null;
function initDebugLog() {
  const logPath = join3(SKILL_ROOT, "poker-debug.log");
  debugStream = createWriteStream(logPath, { flags: "w" });
  debugStream.on("error", () => {
    debugStream = null;
  });
}
function debug(label, data) {
  if (!debugStream) return;
  const ts = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
  const lines = [`[${ts}] ${label}`];
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === "string" && val.includes("\n")) {
      lines.push(`  ${key}: |`);
      for (const line of val.split("\n")) lines.push(`    ${line}`);
    } else {
      lines.push(`  ${key}: ${JSON.stringify(val)}`);
    }
  }
  debugStream.write(lines.join("\n") + "\n\n");
}
function handSessionId(gameId, handNumber) {
  return `poker-${gameId}-h${handNumber}`;
}
function processStateEvent(view, context) {
  const outputs = [];
  const handChanged = context.prevState != null && context.prevState.handNumber !== view.handNumber;
  if (handChanged) {
    const prevHandNum = context.prevState.handNumber;
    if (prevHandNum > (context.lastReportedHand || 0)) {
      const prevPhase2 = context.prevState.phase;
      if (ACTIVE_PHASES.has(prevPhase2)) {
        const prevHdr = `**[Hand #${prevHandNum}]**`;
        const winners = new Set(view.lastHandResult?.winners || []);
        for (const p of context.prevState.players || []) {
          if (p.seat === context.prevState.yourSeat) continue;
          if (p.status === "active" && !winners.has(p.seat)) {
            outputs.push({ type: "EVENT", message: `${prevHdr} ${p.name} folded`, handNumber: prevHandNum });
          }
        }
      }
      if (view.yourChips === 0 && view.canRebuy) {
        outputs.push({ type: "REBUY_AVAILABLE", state: view, handNumber: prevHandNum });
      } else {
        outputs.push({ type: "HAND_RESULT", state: view, handNumber: prevHandNum });
      }
      context.lastReportedHand = prevHandNum;
    }
  }
  const prevPlayerCount = context.prevState?.players?.length ?? 0;
  const newEvents = diffStates(context.prevState, view);
  for (const message of newEvents) {
    outputs.push({ type: "EVENT", message, handNumber: view.handNumber });
  }
  const prevPhase = context.prevPhase;
  context.prevState = view;
  context.prevPhase = view.phase;
  if (view.phase !== prevPhase) {
    context.lastActionType = null;
    context.lastTurnKey = null;
  }
  if (view.isYourTurn) {
    const turnKey = `${view.handNumber}:${view.phase}`;
    if (turnKey !== context.lastTurnKey) {
      context.lastTurnKey = turnKey;
      outputs.push({ type: "YOUR_TURN", state: view, summary: buildSummary(view) });
      context.lastActionType = "YOUR_TURN";
    }
    return outputs;
  }
  context.lastTurnKey = null;
  if (!handChanged) {
    const handJustEnded = ACTIVE_PHASES.has(prevPhase) && (view.phase === "SHOWDOWN" || view.phase === "WAITING");
    if (handJustEnded) {
      const handNum = view.handNumber;
      if (handNum > (context.lastReportedHand || 0)) {
        if (view.yourChips === 0 && view.canRebuy) {
          outputs.push({ type: "REBUY_AVAILABLE", state: view, handNumber: handNum });
          context.lastActionType = "REBUY_AVAILABLE";
        } else {
          outputs.push({ type: "HAND_RESULT", state: view, handNumber: handNum });
          context.lastActionType = "HAND_RESULT";
        }
        context.lastReportedHand = handNum;
      }
      return outputs;
    }
  }
  if (view.phase === "WAITING" && view.players && view.players.length < 2 && prevPlayerCount >= 2) {
    if (context.lastActionType !== "WAITING_FOR_PLAYERS") {
      outputs.push({ type: "WAITING_FOR_PLAYERS", state: view });
      context.lastActionType = "WAITING_FOR_PLAYERS";
    }
    return outputs;
  }
  return outputs;
}
var CHANNEL_ALIASES = /* @__PURE__ */ new Set(["--channel"]);
var CHAT_ID_ALIASES = /* @__PURE__ */ new Set(["--chat-id", "--target", "--to"]);
var ACCOUNT_ALIASES = /* @__PURE__ */ new Set(["--account"]);
function parseDirectArgs(argv) {
  let channel = null;
  let chatId = null;
  let account = null;
  let debugFlag = false;
  for (let i = 0; i < argv.length; i++) {
    if (CHANNEL_ALIASES.has(argv[i]) && argv[i + 1]) channel = argv[i + 1];
    if (CHAT_ID_ALIASES.has(argv[i]) && argv[i + 1]) chatId = argv[i + 1];
    if (ACCOUNT_ALIASES.has(argv[i]) && argv[i + 1]) account = argv[i + 1];
    if (argv[i] === "--debug") debugFlag = true;
  }
  const enabled = !!(channel && chatId);
  return { enabled, channel, chatId, account, debug: debugFlag };
}
var deliveryAccount = null;
var notifyAgentId = "main";
var gatewayClient = new GatewayWsClient({ emit: (obj) => emit(obj) });
var currentHandNumber = null;
var warmupDone = Promise.resolve();
var decisionSeq = 0;
var lastDecision = Promise.resolve();
var consecutiveDecisionFailures = 0;
var MAX_CONSECUTIVE_FAILURES = 3;
var onFatalDecisionFailure = null;
var lastHandUpdateTime = 0;
var HAND_UPDATE_COOLDOWN_MS = 3e4;
var gameStartedEmitted = false;
var recentEvents = [];
var currentHandEvents = [];
var stackBeforeHand = null;
var foldedInHand = null;
function sendDecision(channel, chatId, gameId, prompt, backendUrl, apiKey, context) {
  const mySeq = ++decisionSeq;
  const myHandNumber = currentHandNumber;
  lastDecision = lastDecision.then(() => warmupDone).then(async () => {
    if (mySeq !== decisionSeq) {
      emit({ type: "DECISION_STALE", skipped: mySeq, current: decisionSeq });
      return;
    }
    let agentText = "";
    try {
      const sessionKey = `agent:${notifyAgentId}:subagent:${handSessionId(gameId, myHandNumber)}`;
      const result = await gatewayClient.callAgent({
        agentId: notifyAgentId,
        sessionKey,
        sessionId: handSessionId(gameId, myHandNumber),
        message: prompt,
        thinking: "low",
        timeout: 55
      }, 65e3);
      agentText = [...result.payloads || []].reverse().find((p) => p.text)?.text || "";
    } catch (err) {
      if (mySeq !== decisionSeq) {
        emit({ type: "DECISION_STALE", skipped: mySeq, current: decisionSeq });
        notifyAgent(channel, chatId, controlSignals.decisionTimedOut());
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      consecutiveDecisionFailures++;
      emit({ type: "DECISION_FAILURE", consecutive: consecutiveDecisionFailures, error: msg });
      if (consecutiveDecisionFailures >= MAX_CONSECUTIVE_FAILURES && onFatalDecisionFailure) {
        const reason = `${consecutiveDecisionFailures} consecutive decision failures`;
        await notifyAgent(channel, chatId, controlSignals.decisionFailureExit(consecutiveDecisionFailures));
        onFatalDecisionFailure(reason);
        return;
      }
      notifyAgent(channel, chatId, controlSignals.decisionAutoFolded());
      return;
    }
    if (mySeq !== decisionSeq) {
      emit({ type: "DECISION_STALE", skipped: mySeq, current: decisionSeq });
      notifyAgent(channel, chatId, controlSignals.decisionTimedOut());
      return;
    }
    let decision;
    try {
      const decStart = agentText.indexOf("{");
      const decEnd = agentText.lastIndexOf("}");
      if (decStart >= 0 && decEnd > decStart) {
        decision = JSON.parse(agentText.slice(decStart, decEnd + 1));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ type: "DECISION_PARSE_ERROR", error: msg, agentText: agentText.slice(0, 300) });
    }
    if (decision) {
      debug("DECISION_RESPONSE", { hand: myHandNumber, decision, rawAgentText: agentText.slice(0, 500) });
    }
    if (!decision?.action) {
      consecutiveDecisionFailures++;
      emit({ type: "DECISION_FAILURE", consecutive: consecutiveDecisionFailures, reason: "no_action", agentText: agentText.slice(0, 300) });
      if (consecutiveDecisionFailures >= MAX_CONSECUTIVE_FAILURES && onFatalDecisionFailure) {
        const reason = `${consecutiveDecisionFailures} consecutive decision failures`;
        await notifyAgent(channel, chatId, controlSignals.decisionFailureExit(consecutiveDecisionFailures));
        onFatalDecisionFailure(reason);
        return;
      }
      notifyAgent(channel, chatId, controlSignals.decisionAutoFolded());
      return;
    }
    consecutiveDecisionFailures = 0;
    if (decision.action === "fold") {
      foldedInHand = myHandNumber;
    }
    if (currentHandNumber !== myHandNumber) {
      emit({ type: "DECISION_STALE_HAND", decidedHand: myHandNumber, currentHand: currentHandNumber, action: decision.action });
      notifyAgent(channel, chatId, controlSignals.decisionStaleHand(decision.action));
      return;
    }
    const body = {
      action: decision.action
    };
    if (decision.amount != null) body.amount = decision.amount;
    if (decision.narration) body.reasoning = decision.narration;
    try {
      const resp = await fetch(`${backendUrl}/api/me/game/action`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5e3)
      });
      debug("ACTION_SUBMITTED", { hand: myHandNumber, action: decision.action, amount: decision.amount, narration: decision.narration, status: resp.status });
      if (resp.ok) {
        if (decision.narration) {
          recentEvents.push(decision.narration);
          if (recentEvents.length > 20) recentEvents.shift();
        }
      } else {
        context.lastTurnKey = null;
        const reason = await resp.text().catch(() => null);
        emit({ type: "ACTION_REJECTED", status: resp.status, action: decision.action, reason });
        notifyAgent(channel, chatId, controlSignals.actionRejected(resp.status, reason || "unknown reason"));
      }
    } catch (actionErr) {
      const actionErrMsg = actionErr instanceof Error ? actionErr.message : String(actionErr);
      emit({ type: "ACTION_SUBMIT_ERROR", error: actionErrMsg, action: decision.action });
      await new Promise((r) => setTimeout(r, 3e3));
      try {
        const retryResp = await fetch(`${backendUrl}/api/me/game/action`, {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(1e4)
        });
        if (retryResp.ok) {
          emit({ type: "ACTION_RETRY_OK", action: decision.action });
          if (decision.narration) {
            recentEvents.push(decision.narration);
            if (recentEvents.length > 20) recentEvents.shift();
          }
        } else {
          emit({ type: "ACTION_RETRY_REJECTED", status: retryResp.status, action: decision.action });
        }
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        emit({ type: "ACTION_RETRY_FAILED", error: retryMsg, action: decision.action });
      }
      context.lastTurnKey = null;
    }
  }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "DECISION_CHAIN_ERROR", error: msg });
  });
}
function readHandNotes() {
  try {
    return readFileSync3(join3(SKILL_ROOT, "poker-hand-notes.txt"), "utf8").trim();
  } catch {
    return "";
  }
}
function notifyAgent(channel, chatId, message) {
  const accountArgs = deliveryAccount ? ["--reply-account", deliveryAccount] : [];
  return new Promise((resolve) => {
    execFile("openclaw", [
      "agent",
      "--agent",
      notifyAgentId,
      "--message",
      message,
      "--deliver",
      "--reply-channel",
      channel,
      "--reply-to",
      chatId,
      ...accountArgs
    ], { timeout: 6e4 }, (err) => {
      if (err) emit({ type: "NOTIFY_AGENT_ERROR", error: err.message });
      resolve();
    });
  });
}
function notifyAgentSilent(message) {
  return new Promise((resolve) => {
    execFile("openclaw", [
      "agent",
      "--agent",
      notifyAgentId,
      "--message",
      message
    ], { timeout: 6e4 }, (err) => {
      if (err) emit({ type: "NOTIFY_AGENT_ERROR", error: err.message });
      resolve();
    });
  });
}
process.on("uncaughtException", (err) => {
  emit({ type: "CRASH", error: err.message });
  debugStream?.end();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  emit({ type: "CRASH", error: msg });
  debugStream?.end();
  process.exit(1);
});
var INSIGHTS_FILE = join3(SKILL_ROOT, "poker-session-insights.txt");
function readSessionInsights() {
  try {
    return readFileSync3(INSIGHTS_FILE, "utf8").trim();
  } catch {
    return "";
  }
}
function writeSessionInsights(insights) {
  try {
    writeFileSync(INSIGHTS_FILE, insights + "\n");
  } catch {
  }
}
async function main() {
  const backendUrl = "https://api.clawplay.fun";
  const config = readClawPlayConfig();
  const apiKey = resolveApiKey(config) ?? "";
  if (!apiKey) {
    emit({ type: "CONNECTION_ERROR", error: "CLAWPLAY_API_KEY_PRIMARY must be set (env var, or apiKeyEnvVar in clawplay-config.json). Usage: node poker-listener.js --channel <name> --chat-id <id>" });
    process.exit(1);
  }
  let gameId = "unknown";
  const direct = parseDirectArgs(process.argv);
  if (!direct.enabled || !direct.channel || !direct.chatId) {
    emit({ type: "CONNECTION_ERROR", error: "--channel and --chat-id are required" });
    process.exit(1);
  }
  if (direct.debug) initDebugLog();
  const channel = direct.channel;
  const chatId = direct.chatId;
  deliveryAccount = direct.account ?? config.accountId ?? null;
  notifyAgentId = config.agentId ?? "main";
  emit({ type: "DELIVERY_MODE", channel, chatId: "***", account: deliveryAccount ?? "default", agentId: notifyAgentId });
  try {
    await gatewayClient.connect();
  } catch (gwErr) {
    const msg = gwErr instanceof Error ? gwErr.message : String(gwErr);
    emit({ type: "GW_CONNECT_FAILED", error: msg });
  }
  const sseUrl = `${backendUrl}/api/me/game/stream?token=${apiKey}`;
  let EventSourceClass;
  try {
    const mod = await Promise.resolve().then(() => (init_dist2(), dist_exports));
    EventSourceClass = mod.default || mod.EventSource;
  } catch {
    emit({ type: "CONNECTION_ERROR", error: "eventsource package not available" });
    process.exit(1);
  }
  const context = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
  let es;
  let sseFirstConnect = true;
  let lastEventTime = Date.now();
  let lastStateEventTime = Date.now();
  const HEARTBEAT_TIMEOUT_MS = 9e4;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  const RECONNECT_DELAY_MS = 3e3;
  let heartbeatCheckRunning = false;
  const heartbeatCheck = setInterval(async () => {
    if (heartbeatCheckRunning) return;
    if (Date.now() - lastEventTime > HEARTBEAT_TIMEOUT_MS) {
      heartbeatCheckRunning = true;
      try {
        emit({ type: "HEARTBEAT_TIMEOUT", lastEventAge: Date.now() - lastEventTime });
        try {
          const resp = await fetch(`${backendUrl}/api/me/game`, {
            headers: { "x-api-key": apiKey },
            signal: AbortSignal.timeout(5e3)
          });
          if (!resp.ok) {
            emit({ type: "STATUS_CHECK", status: resp.status });
            gracefulExit("Left the table", 0);
            return;
          }
        } catch {
        }
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          gracefulExit("Connection lost after reconnect attempts", 1);
        } else {
          reconnectAttempts++;
          emit({ type: "SSE_RECONNECT_ATTEMPT", attempt: reconnectAttempts });
          es.close();
          setTimeout(() => connectSSE(), RECONNECT_DELAY_MS * 2 ** (reconnectAttempts - 1));
        }
      } finally {
        heartbeatCheckRunning = false;
      }
    } else if (Date.now() - lastStateEventTime > HEARTBEAT_TIMEOUT_MS) {
      heartbeatCheckRunning = true;
      try {
        emit({ type: "STATE_SILENCE_DETECTED", lastStateAge: Date.now() - lastStateEventTime });
        try {
          const resp = await fetch(`${backendUrl}/api/me/game`, {
            headers: { "x-api-key": apiKey },
            signal: AbortSignal.timeout(5e3)
          });
          if (!resp.ok) {
            emit({ type: "STATUS_CHECK", status: resp.status });
            gracefulExit("Left the table", 0);
            return;
          }
          lastStateEventTime = Date.now();
        } catch {
        }
      } finally {
        heartbeatCheckRunning = false;
      }
    }
  }, 15e3);
  let exitInProgress = false;
  function gracefulExit(reason, exitCode) {
    if (exitInProgress) return;
    exitInProgress = true;
    clearInterval(heartbeatCheck);
    gatewayClient.stop();
    debugStream?.end();
    const isRebuyState = exitCode !== 0 && context.prevState?.canRebuy === true && context.prevState?.yourChips === 0;
    const finalStack = context.prevState?.yourChips ?? "unknown";
    if (reason !== "Table closed" && !isRebuyState) {
      fetch(`${backendUrl}/api/me/game/leave`, {
        method: "POST",
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(3e3)
      }).catch(() => {
      });
    }
    const forceExit = setTimeout(() => {
      es?.close();
      process.exit(exitCode);
    }, 3e4);
    forceExit.unref();
    if (isRebuyState) {
      clearTimeout(forceExit);
      es?.close();
      process.exit(exitCode);
      return;
    }
    const notifyDone = exitCode === 0 ? notifyAgent(channel, chatId, controlSignals.gameOver(gameId, reason, finalStack)) : notifyAgent(channel, chatId, controlSignals.connectionError(gameId, reason, finalStack));
    notifyDone.then(() => {
      clearTimeout(forceExit);
      es?.close();
      process.exit(exitCode);
    });
  }
  onFatalDecisionFailure = (reason) => gracefulExit(reason, 1);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      emit({ type: "SIGNAL_EXIT", signal });
      gracefulExit("Session terminated", 0);
    });
  }
  function connectSSE() {
    if (es) es.close();
    es = new EventSourceClass(sseUrl);
    lastEventTime = Date.now();
    lastStateEventTime = Date.now();
    es.onopen = () => {
      lastEventTime = Date.now();
      lastStateEventTime = Date.now();
      reconnectAttempts = 0;
      consecutiveDecisionFailures = 0;
      if (sseFirstConnect) {
        sseFirstConnect = false;
        try {
          unlinkSync(join3(SKILL_ROOT, "poker-notes.txt"));
        } catch {
        }
        try {
          unlinkSync(join3(SKILL_ROOT, "poker-hand-notes.txt"));
        } catch {
        }
        try {
          unlinkSync(INSIGHTS_FILE);
        } catch {
        }
        debug("SESSION_WARMUP", { gameId });
        warmupDone = gatewayClient.callAgent({
          agentId: notifyAgentId,
          sessionKey: `agent:${notifyAgentId}:subagent:poker-warmup`,
          sessionId: "poker-warmup",
          message: WARMUP_MESSAGE,
          thinking: "low",
          timeout: 15
        }, 2e4).then(() => {
        }).catch(() => {
        });
      } else {
        emit({ type: "SSE_RECONNECT" });
      }
    };
    es.addEventListener("state", (event) => {
      try {
        lastEventTime = Date.now();
        lastStateEventTime = Date.now();
        const view = JSON.parse(event.data);
        if (gameId === "unknown" && view.gameId) gameId = view.gameId;
        reconnectAttempts = 0;
        const prevHandNumber = currentHandNumber;
        const handJustChanged = view.handNumber !== currentHandNumber;
        currentHandNumber = view.handNumber;
        if (handJustChanged) {
          debug("HAND_CHANGED", { from: prevHandNumber, to: view.handNumber, stack: view.yourChips });
          if (prevHandNumber !== null) {
            const recentHandLines = view.recentHands?.length ? view.recentHands.slice(-5).map(formatRecentHand) : [];
            const opponentStatsLines = view.playerStats ? formatOpponentStats(view.playerStats) : [];
            const currentInsights = readSessionInsights() || "No session insights yet.";
            const reflectionPrompt = buildReflectionPrompt(opponentStatsLines, recentHandLines, currentInsights);
            debug("REFLECTION_PROMPT", { hand: view.handNumber, prompt: reflectionPrompt });
            const reflectionHandNumber = view.handNumber;
            warmupDone = gatewayClient.callAgent({
              agentId: notifyAgentId,
              sessionKey: `agent:${notifyAgentId}:subagent:${handSessionId(gameId, reflectionHandNumber)}`,
              sessionId: handSessionId(gameId, reflectionHandNumber),
              message: reflectionPrompt,
              timeout: 12
            }, 18e3).then((result) => {
              const agentText = [...result.payloads || []].reverse().find((p) => p.text)?.text || "";
              const innerStart = agentText.indexOf("{");
              const innerEnd = agentText.lastIndexOf("}");
              if (innerStart >= 0 && innerEnd > innerStart) {
                const parsed = JSON.parse(agentText.slice(innerStart, innerEnd + 1));
                if (parsed.insights && typeof parsed.insights === "string") {
                  writeSessionInsights(parsed.insights.trim());
                  debug("REFLECTION_RESPONSE", { hand: reflectionHandNumber, insights: parsed.insights.trim(), rawAgentText: agentText.slice(0, 500) });
                  emit({ type: "SESSION_INSIGHTS_UPDATED", hand: reflectionHandNumber });
                }
              }
            }).catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              emit({ type: "SESSION_INSIGHTS_PARSE_ERROR", error: msg });
            });
          }
          stackBeforeHand = view.yourChips;
          currentHandEvents = [];
          foldedInHand = null;
          try {
            unlinkSync(join3(SKILL_ROOT, "poker-hand-notes.txt"));
          } catch {
          }
        }
        const prevPlayers = context.prevState?.players || [];
        const outputs = processStateEvent(view, context);
        for (const output of outputs) {
          const outputHand = "handNumber" in output ? output.handNumber : currentHandNumber;
          if (foldedInHand != null && outputHand === foldedInHand && output.type !== "YOUR_TURN" && output.type !== "REBUY_AVAILABLE") {
            continue;
          }
          switch (output.type) {
            case "EVENT":
              if (!gameStartedEmitted && output.message.includes("[Hand #")) {
                emit({ type: "GAME_STARTED" });
                gameStartedEmitted = true;
              }
              recentEvents.push(output.message);
              if (recentEvents.length > 20) recentEvents.shift();
              currentHandEvents.push(output.message);
              break;
            case "YOUR_TURN": {
              const playbook = readPlaybook();
              const notes = readNotes();
              const handNotes = readHandNotes();
              const sessionInsights = readSessionInsights();
              const recentHandLines = output.state.recentHands?.length ? output.state.recentHands.slice(-5).map(formatRecentHand) : recentEvents.filter((e) => e.includes(" won ")).slice(-3);
              const opponentStatsLines = output.state.playerStats ? formatOpponentStats(output.state.playerStats) : [];
              const prompt = buildDecisionPrompt(
                output.summary,
                playbook,
                currentHandEvents,
                recentHandLines,
                opponentStatsLines,
                sessionInsights,
                notes,
                handNotes
              );
              debug("YOUR_TURN", {
                hand: currentHandNumber,
                summary: output.summary,
                playbook: playbook.slice(0, 100) + (playbook.length > 100 ? "..." : ""),
                hasNotes: !!notes,
                hasHandNotes: !!handNotes,
                hasInsights: !!sessionInsights
              });
              debug("DECISION_PROMPT", { hand: currentHandNumber, prompt });
              sendDecision(channel, chatId, gameId, prompt, backendUrl, apiKey, context);
              break;
            }
            case "HAND_RESULT": {
              const summary = buildHandResultSummary(output.state, output.handNumber || currentHandNumber);
              const msg = summary || "Hand complete.";
              recentEvents.push(msg);
              if (recentEvents.length > 20) recentEvents.shift();
              const stackAfter = view.yourChips;
              const bb = view.forcedBets?.bigBlind || 20;
              if (stackBeforeHand != null && stackBeforeHand > 0) {
                const change = Math.abs(stackAfter - stackBeforeHand);
                const changeRatio = change / stackBeforeHand;
                const changeBBs = change / bb;
                let updateReason = null;
                let highPriority = false;
                if (stackAfter >= stackBeforeHand * 2) {
                  updateReason = `Doubled up! ${msg} (${stackBeforeHand} \u2192 ${stackAfter})`;
                  highPriority = true;
                } else if (changeRatio > 0.3) {
                  const direction = stackAfter > stackBeforeHand ? "Won big" : "Lost big";
                  updateReason = `${direction}! ${msg} (${stackBeforeHand} \u2192 ${stackAfter})`;
                  highPriority = true;
                } else if (stackAfter > 0 && stackAfter < bb * 15) {
                  updateReason = `Short-stacked (${stackAfter} chips, ${Math.floor(stackAfter / bb)} BB). ${msg}`;
                  highPriority = true;
                } else if (changeBBs >= 5 && stackAfter > stackBeforeHand) {
                  updateReason = `Nice pot! ${msg} (${stackBeforeHand} \u2192 ${stackAfter}, +${Math.round(changeBBs)} BB)`;
                }
                if (!updateReason) {
                  const busted = view.players?.filter(
                    (p) => p.seat !== view.yourSeat && p.chips === 0 && prevPlayers.some((pp) => pp.seat === p.seat && (pp.chips ?? 0) > 0)
                  );
                  if (busted && busted.length > 0) {
                    const names = busted.map((p) => p.name).join(", ");
                    updateReason = `${names} busted! ${msg}`;
                  }
                }
                if (updateReason) {
                  const now = Date.now();
                  if (highPriority || now - lastHandUpdateTime > HAND_UPDATE_COOLDOWN_MS) {
                    lastHandUpdateTime = now;
                    notifyAgent(channel, chatId, controlSignals.handUpdate(updateReason));
                  }
                }
              }
              break;
            }
            case "WAITING_FOR_PLAYERS":
              notifyAgentSilent(controlSignals.waitingForPlayers(gameId));
              break;
            case "REBUY_AVAILABLE": {
              const amt = output.state?.rebuyAmount || "the default amount";
              notifyAgentSilent(controlSignals.rebuyAvailable(gameId, amt));
              break;
            }
            default:
              emit(output);
          }
        }
        if (view.hasPendingLeave && (view.phase === "SHOWDOWN" || view.phase === "WAITING")) {
          gracefulExit("Left the table", 0);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "CONNECTION_ERROR", error: `Failed to process state event: ${msg}` });
        gracefulExit(`State parse error: ${msg}`, 1);
      }
    });
    es.addEventListener("keepalive", () => {
      lastEventTime = Date.now();
      reconnectAttempts = 0;
    });
    es.addEventListener("closed", () => {
      lastEventTime = Date.now();
      gracefulExit("Table closed", 0);
    });
    es.onerror = (err) => {
      const msg = "message" in err ? err.message : "unknown";
      emit({ type: "CONNECTION_ERROR", error: `SSE connection error: ${msg || "unknown"}` });
    };
  }
  connectSSE();
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
var isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun && process.argv.length > 3) {
  main();
}
export {
  parseDirectArgs,
  processStateEvent,
  readHandNotes,
  sendDecision
};
