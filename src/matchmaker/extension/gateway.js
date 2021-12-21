/**
 * Copyright (c) 2021, Oracle and/or its affiliates. All rights reserved.
 * The Universal Permissive License (UPL), Version 1.0
 */
const Net = require('net');
const Http = require('http');
const WebSocket = require('ws');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const MetricsAdapter = require('./metrics');

const isOpen = (ws) => 
  ws && ws.readyState === WebSocket.OPEN;

const parseQuery = str => 
  new URLSearchParams(str.split('?').pop());

/**
 * A simple base class for this utility
 */
class Common extends EventEmitter {
  constructor(...args) {
    super(...args);
    this._id = Common._id++;
  }

  _log(...args) {
    console.log(`${this.constructor.name} [${this._id}]:`, ...args);
  }
}
Common._id = 0;

/**
 * Main extension entrypoint takes the matchmaker http server
 * and net server (socket) from signaler as its arguments
 */
class PlayerConnectionGateway extends Common {

  /**
   * create a player connection websocket system on the http server
   * @param {object} options
   * @param {http.Server} options.server an exitsting http server (could replace with standalone init/server)
   * @param {Net.Server} options.matchmaker the matchmaker TCP server
   * @param {Map<*>} options.pool cirrus server pool
   * @param {MetricsAdapter} options.metrics metrics adapter
   */
  constructor(options) {
    super();
    const { server, matchmaker, pool, metrics } = options || {};
    if (!(server instanceof Http.Server)) {
      throw new Error('Http server is required for PlayerConnectionGateway');
    }
    if (!(matchmaker instanceof Net.Server)) {
      throw new Error('Matchmaker server is required for PlayerConnectionGateway');
    }
    if (!pool instanceof Map) {
      throw new Error('A streamer availability pool is required');
    }
    if (!metrics instanceof MetricsAdapter) {
      throw new Error('Metrics adapter instance is required');
    }

    this._debug = !!process.env.DEBUG;

    // setup lookup/pool finding
    this.pool = pool;

    // queue of waiting clients
    const queue = this.queue = new Set();

    // setup websocket server on the shared http server 
    const wss = this.wss = new WebSocket.Server({ server });
    wss.on('connection', this.onClientConnection.bind(this));

    // listen to upstream matchmaker TCP connections
    matchmaker.on('connection', this.onStreamerConnection.bind(this));

    // add instruments
    metrics
      .instrumentSocketServer(wss, 'player')
      .gauge('player_queue_count', {
        collect() { this.set(queue.size); }
      })
      .gauge('streamer_available_count', {
        collect() {
          this.set([...pool.values()]
            .filter(s => s.numConnectedClients === 0 && s.ready === true)
            .length)
        }
      })
      .gauge('streamer_demand_ratio', {
        collect() {
          const players = wss.clients.size;
          const poolSize = [...pool.values()].filter(s => s.ready === true).length;
          this.set(poolSize > 0 ? players/poolSize :
            (players > 0 ? players + 1 : 0)) // case when there's no streamer pool
        }
      });

    // ready
    this._log(`initialized`);
  }

  /**
   * process waiting player queue and attempt matching to streamers
   * @returns {void}
   */
  connectWaitingPlayers() {
    const size = this.queue.size;
    if (size) {
      this._log(`dequeue ${size} waiting player(s)`);
      for (const player of this.queue.values()) {
        const server = this.nextAvailable();
        if (!server) {
          this._log('more players than available servers. await next status change')
          break;
        } else {
          this.assignPlayer(player, server);
        }
      }
    }
  }

  /**
   * obtain a server with available connection
   * @returns {object} matched server
   */
  nextAvailable() {
    const liveTime = Date.now() - 6e4; // last ping threshold within last minute
    for (const server of this.pool.values()) {
      if (server.numConnectedClients === 0 && !server.allocated && // unreserved
        server.lastPingReceived >= liveTime &&    // still beating
        (server.ready === true || this._debug)) { // readiness
        return server;
      }
    }
  }

  /**
   * assigns a player to a server for the lifecycle of the session
   * @param {VirtualPlayer} player 
   * @param {*} server 
   */
  assignPlayer(player, server) {
    this.queue.delete(player);
    if (isOpen(player.ws)) {
      server.allocated = true;
      // handle dealloc
      const freeServer = () => server.allocated = false;
      player
        // if the streamer dropped, add player back to queue
        .on('drop', () => isOpen(player.ws) && this.queue.add(player))
        // when the player disconnects
        .on('disconnect', freeServer)
        // make connection (returns the new socket to signal server)
        .connectStreamer(server)
          // likely a problem with the streamer... might not be reusable
          .on('error', freeServer);
    }
  }

  /**
   * call
   * @param {net.Socket} connection 
   * @see https://nodejs.org/api/net.html#class-netsocket
   */
  onStreamerConnection(socket) {
    // const addr = { port: 12346, family: 'IPv4', address: '127.0.0.1' }
    this._log('streamer registered', {
      local: `${socket.localAddress}:${socket.localPort}`,
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      family: socket.remoteFamily,
    });
    // handle socket emits  
    socket
      .on('error', (e) => this._log(`streamer socket error:`, e))
      // data from streamer usually changes availability or readiness
      .on('data', () => this.connectWaitingPlayers());
  }

  /**
   * handle an actual player websocket connection which acts as a virtual
   * gateway to the cirrus websocket listener
   * @param {*} ws 
   */
  onClientConnection(ws, req) {
    this._log('client connected', req.url);
    // add the player to a list of waiting players
    const player = new VirtualPlayer(ws);
    // auto dequeue on disconnect
    this.queue.add(player
      .on('disconnect', () => this.queue.delete(player)));
    // process waitlist (queue)
    this.connectWaitingPlayers();
  }

}


/**
 * Definition for a virtual player who holds the client
 * websocket connection and is assigned a server upon 
 * availability
 */
class VirtualPlayer extends Common {

  /**
   * instantiate with the waiting client websocket
   * @param {WebSocket} ws 
   */
  constructor(ws) {
    super();
    this.id = VirtualPlayer.id++;
    this._log('created virtual player instance');
    // create heartbeat
    const hb = setInterval(this._clientHeartbeat.bind(this), 3e4);
    // setup on the client ws connection
    ws.alive = true;
    this.ws = ws;
    this.ws
      .on('pong', () => this.ws.alive = true) // pong from the server
      .on('message', this.onClientMessage.bind(this)) // relay to streamer
      .on('close', () => { clearInterval(hb); this.disconnect(); }); // maint
    // indicate wait
    this.sendNotice('Waiting for available streamer');
  }

  /**
   * interval ping/pong with client connection
   * @returns 
   */
  _clientHeartbeat() {
    const ws = this.ws;
    if (!ws.alive) {
      return ws.terminate();
    } else {
      ws.alive = false;
      ws.ping();
    }
  }

  /**
   * pass client websocket messages to the stream (cirrus)
   * @param {*} msg 
   */
  onClientMessage(msg) {
    msg = msg.toString();
    this._log('--> forward client message to streamer -->');
    if (isOpen(this.stream)) {
      this.stream.send(msg);
    } else {
      this._log('cannot forward client message to non-existent stream');
    }
  }

  /**
   * pass cirrus websocket messages to the client
   * @param {*} msg 
   */
  onStreamerMessage(msg) {
    msg = msg.toString();
    this._log('<-- relay streamer message to client <--', msg);
    if (isOpen(this.ws)) {
      this.ws.send(msg);
    } else {
      this._log('cannot relay streamer message to non-existent client');
    }
  }

  /**
   * attach as a client to the designated signaler 
   * @param {*} backend
   * @returns {WebSocket} socket connection 
   */
  connectStreamer(backend) {
    this._log('connecting to stream', backend);

    function pong() {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = setTimeout(() => {
        this.terminate();
      }, 30000 + 1000);
    }

    // setup base connection and listeners
    const { port, address } = backend;
    const ss = this.stream = new WebSocket(`ws://${address}:${port}?player=${this._id}`);
    ss.on('open', pong)
      .on('ping', pong)
      .on('close', function clear() { clearTimeout(this.pingTimeout) })

    // hook up functional listeners
    ss.on('open', () => this._log('connected to signal server'))
      .on('close', (e) => this.handleStreamerClose(e))
      .on('message', this.onStreamerMessage.bind(this));

    // notify the client that magic awaits
    this.sendNotice(backend);

    return ss;
  }

  /**
   * send a notice to the waiting client
   * @param {*} detail 
   */
  sendNotice(detail) {
    this.ws.send(JSON.stringify({
      type: 'matchmaker',
      queued: !this.stream,
      matched: !!this.stream,
      detail,
    }));
  }

  /**
   * handle case where streamer drops, but client is still possibly connected
   */
  handleStreamerClose(e) {
    this._log('player <--> streamer connection closed', e);
    this.stream = null;
    this.emit('drop', e);
    this.sendNotice('Streamer dropped');
  }

  /**
   * closes the virtual player connections
   */
  disconnect() {
    this._log('player allocation disconnect');
    this.emit('disconnect');
    this.ws.close();
    this.stream && this.stream.close();
  }

}

module.exports = PlayerConnectionGateway;