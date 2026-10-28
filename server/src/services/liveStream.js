/**
 * LiveStream Service (Server-Sent Events — SSE)
 * 
 * Provides real-time unidirectional event streaming (Server -> Client) over HTTP.
 * Why SSE over WebSockets here?
 * 1. Bids and mutations are already handled over secure HTTP POST with CSRF and cookie validation.
 * 2. SSE runs over standard HTTP/1.1 and HTTP/2 without a protocol upgrade handshake.
 * 3. Native browser EventSource handles automatic exponential backoff and reconnections.
 * 4. Lightweight memory footprint with Set-based channel subscription pools.
 */

// Map of productId -> Set of active Express Response objects
const subscriptions = new Map();

/**
 * subscribe
 * Connects an incoming HTTP client request to a product's live event stream.
 */
function subscribe(productId, req, res) {
  const channelKey = String(productId);

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no" // Disable buffering for NGINX/reverse proxies
  });

  // Send an initial connected handshake event
  res.write(`event: connected\ndata: ${JSON.stringify({ channel: channelKey, timestamp: new Date().toISOString() })}\n\n`);

  if (!subscriptions.has(channelKey)) {
    subscriptions.set(channelKey, new Set());
  }
  const channel = subscriptions.get(channelKey);
  channel.add(res);

  // Keep connection open with periodic SSE comments (: keep-alive) every 25 seconds
  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);

  // Clean up when client drops connection
  req.on("close", () => {
    clearInterval(keepAlive);
    channel.delete(res);
    if (channel.size === 0) {
      subscriptions.delete(channelKey);
    }
  });
}

/**
 * broadcast
 * Pushes an event payload to all clients currently watching a product.
 */
function broadcast(productId, eventName, payload) {
  const channelKey = String(productId);
  const channel = subscriptions.get(channelKey);
  if (!channel || channel.size === 0) return;

  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const clientRes of channel) {
    try {
      clientRes.write(message);
    } catch (err) {
      channel.delete(clientRes);
    }
  }
}

/**
 * getActiveListenersCount
 * Useful for monitoring and interview discussions on server connection pools.
 */
function getActiveListenersCount(productId) {
  const channelKey = String(productId);
  return subscriptions.get(channelKey)?.size || 0;
}

module.exports = {
  subscribe,
  broadcast,
  getActiveListenersCount
};

