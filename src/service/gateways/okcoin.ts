/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />
///<reference path="../interfaces.ts"/>

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import ws = require("ws");
import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
import log from "../logging";
import crc32 = require("crc-32");
import { Socket } from "net";
import pako = require("pako");

let shortId = require("shortid");


interface OkCoinMessageIncomingMessage {
    channel?: string;
    table?: string;
    data?: any;
    event?: string;
    action?: string;
    success?: boolean;
}

interface OkCoinDepthMessage {
    asks: [string, string, string][];
    bids: [string, string, string][];
    timestamp: string;
    checksum: number;
    instrument_id: string;
}

interface OkCoinTradeMessage {
    trade_id: string;
    instrument_id: string;
    price: string;
    side: string;
    size: string;
    timestamp: string;
}

interface OrderAck {
    result: string; // "true" or "false"
    order_id: number;
}

interface SignedMessage {
    api_key?: string;
    sign?: string;
}

interface Order extends SignedMessage {
    client_oid: string,
    type: string,
    side: string,
    instrument_id: string;
    margin_trading?: Int8Array,
    price?: string;
    size?: string;
    notional?: string;
}

interface Cancel extends SignedMessage {
    order_id?: string;
    instrument_id: string;
    client_oid?: string;
}

interface OkCoinOrderStatus {
    order_id: string,
    client_oid: string,
    price: string,
    size: string,
    notional: string,
    instrument_id: string,
    side: string,
    type: string,
    timestamp: string,
    filled_size: string,
    filled_notional: string,
    status: string,
    margin_trading: string

    // averagePrice: string;
    // completedTradeAmount: string;
    // createdDate: string;
    // id: string;
    // orderId: string;
    // sigTradeAmount: string;
    // sigTradePrice: string;
    // status: number;
    // symbol: string;
    // tradeAmount: string;
    // tradePrice: string;
    // tradeType: string;
    // tradeUnitPrice: string;
    // unTrade: string;
}

interface SubscriptionRequest extends SignedMessage { }

class OkCoinWebsocket {
    send = <T>(operation: string, args: any, cb?: () => void) => {
        let subsReq: any = { op: operation };

        if (args !== null)
            subsReq.args = args;

        this._ws.send(JSON.stringify(subsReq), (e: Error) => {
            if (!e && cb) cb();
        });
    }

    login = (signer: OkCoinMessageSigner, cb?: () => void) => {
        let timestamp = (Date.now() / 1000).toString();
        let loginChannel = [signer.apiKey,
        signer.passphrase,
            timestamp,
        signer.ComputeHmac256(timestamp + "GET" + "/users/self/verify")
        ];
        this.send("login", loginChannel);
        this._loginHandlers[shortId.generate()] = cb;
    }

    setHandler = <T>(channel: string, handler: (newMsg: Models.Timestamped<T>) => void) => {
        this._handlers[channel] = handler;
    }

    checksum = (bids: Models.MarketSide[], asks: Models.MarketSide[], c: number) => {
        if (bids == null || asks == null) {
            return false;
        }
        const buff = [];
        for (let i = 0; i < 25; i++) {
            if (bids[i]) {
                const bid = bids[i];
                buff.push(bid[0]);
                buff.push(bid[1]);
            }
            if (asks[i]) {
                const ask = asks[i];
                buff.push(ask[0]);
                buff.push(ask[1]);
            }
        }
        const checksum = crc32.str(buff.join(":"));
        if (checksum === c) {
            return true;
        }
        return false;
    }

    private onMessage = (raw: any) => {

        try {
            if (!(typeof raw === 'string')) {
                raw = pako.inflateRaw(raw, { to: 'string' });
            }

            this._log.info({ "onMessage received": raw }, "Okex websocket on message!");
            this.resetTimer();
            let t = Utils.date();

            if (typeof raw !== "undefined" && raw === this._heartbeatPong) {
                return;
            }
            let msg: OkCoinMessageIncomingMessage = JSON.parse(raw);
            if (typeof msg.event !== "undefined" && msg.event == "subscribe") {
                return;
            }
            if (typeof msg.event !== "undefined" && msg.event == "unsubscribe") {
                this.send("subscribe", [msg.channel]);
                return;
            }
            if (typeof msg.event !== "undefined" && msg.event == "login") {
                if (!msg.success) {
                    this._log.warn("Unsuccessful login!", msg);
                }
                else {
                    this.LoggedIn = true;
                    this._log.info("Successfully login!", msg);
                    // _.forEach(this._loginHandlers, rid => {
                    //     let handler = this._loginHandlers[rid];
                    //     handler();
                    //     this._log.info("calling handler!");
                    // });

                    _.forEach(this._loginHandlers, handler => {
                        handler();
                        this._log.info("calling handler!");
                    });
                    return;
                }
            }

            if (typeof msg.table !== "undefined" && msg.data !== "undefined" && msg.data.length > 0) {
                let handler: (x: Models.Timestamped<any>) => void;

                if (msg.table == "spot/depth" && msg.action === "update") {
                    handler = this._handlers["spot/depthUpdate"];
                } else if (msg.table == "spot/depth" && msg.action === "partial") {
                    handler = this._handlers["spot/depth"];
                } else if (msg.table == "spot/trade") {
                    handler = this._handlers["spot/trade"];
                } else if (msg.table == "spot/order") {
                    handler = this._handlers["spot/order"];
                }

                if (typeof handler === "undefined") {
                    this._log.warn("Got message on unknown topic", msg);
                    return;
                }
                if (msg.table == "spot/depth") {
                    handler(new Models.Timestamped<OkCoinDepthMessage>(msg.data[0], t));
                }
                if (msg.table == "spot/trade") {
                    handler(new Models.Timestamped<OkCoinTradeMessage[]>(msg.data[0], t));
                }
                if (msg.table == "spot/order") {
                    handler(new Models.Timestamped<OkCoinOrderStatus[]>(msg.data[0], t));
                }
                return;
            }
        }
        catch (e) {
            this._log.error(e, "Error parsing msg %o", raw);
            throw e;
        }
    };

    private onOpen = () => {
        this._log.info("Okex websocket on open!");
        this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected);
        this.initTimer();
    }
    private onClose = (code: number, message: string) => {
        this._log.info("Okex websocket on close! code: " + code + +"message :" + message);
        this._ws = undefined;
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
        this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected);
    }

    private initTimer = () => {
        this._interval = setInterval(() => {
            if (this._ws) {
                this._ws.send(this._heartbeatPing);
            }
        }, 5000);
    }

    private resetTimer = () => {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
            this.initTimer();
        }
    }

    private close = () => {
        if (this._ws) {
            console.log(`Closing websocket connection...`);
            this._ws.close();
            if (this._interval) {
                clearInterval(this._interval);
                this._interval = null;
            }
            this._ws = undefined;
        }
    }

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    LoggedIn: boolean = false;
    private _heartbeatPing = "ping";
    private _heartbeatPong = "pong";
    private _log = log("tribeca:gateway:OkCoinWebsocket");
    private _handlers: { [channel: string]: (newMsg: Models.Timestamped<any>) => void } = {};
    private _loginHandlers: { [rid: string]: () => void } = {};

    private _ws: ws;
    private _interval?: NodeJS.Timer | null;

    constructor(config: Config.IConfigProvider) {
        let okWs = config.GetString("OkCoinWsUrl");
        this._ws = new ws(okWs);
        this._log.info({ "OkCoinWsUrl": okWs }, "Constructing OkCoinWebsocket!");
        this._ws.on("open", () => { this.onOpen(); });
        this._ws.on("message", msg => { this.onMessage(msg); });
        this._ws.on("close", (code, message) => { this.onClose(code, message); });
    }
}

class OkCoinMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    /*  trade = {
            "table": "spot/trade",
            "data": [
                [{"instrument_id": "BTC-USDT","price": "22888","side": "buy","size": "7","timestamp": "2018-11-22T03:58:57.709Z","trade_id": "108223090144493569"}]
            ]
        }; */

    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrade = (trades: Models.Timestamped<OkCoinTradeMessage[]>) => {
        // [tid, price, amount, time, type]
        _.forEach(trades.data, trade => {
            let px = parseFloat(trade.price);
            let amt = parseFloat(trade.size);
            let side = trade.side === "ask" ? Models.Side.Ask : Models.Side.Bid; // is this the make side?
            let mt = new Models.GatewayMarketTrade(px, amt, trades.time, trades.data.length > 0, side);
            this.MarketTrade.trigger(mt);
        });
    };

    /*  depth={
            "table": "spot/depth",
            "action": "partial",
            "data": [{
                "instrument_id": "ETH-USDT",
                "asks": [["8.8", "96.99999966", 1],["9", "39", 3],["9.5", "100", 1],["12", "12", 1],["95", "0.42973686", 3],["11111", "1003.99999795", 1]],
                "bids": [["5", "7", 4],["3", "5", 3],["2.5", "100", 2],["1.5", "100", 1],["1.1", "100", 1],["1", "1004.9998", 1]]
                "timestamp": "2018-12-18T07:27:13.655Z",
                "checksum": 468410539
            }]
        }; */

    // TODO: Sort order?
    MarketData = new Utils.Evt<Models.Market>();
    private _market: Models.Market = null;
    private static GetLevel = (n: [string, string, string]): Models.MarketSide => new Models.MarketSide(parseFloat(n[0]), parseFloat(n[1]));
    private onDepth = (depth: Models.Timestamped<OkCoinDepthMessage>) => {
        let depthData = depth.data;
        let bids = _(depthData.bids).map(OkCoinMarketDataGateway.GetLevel).value();
        let asks = _(depthData.asks).map(OkCoinMarketDataGateway.GetLevel).value();
        this._market = new Models.Market(bids, asks, depth.time);
        this.MarketData.trigger(this._market);
    };

    private merge = (a: Models.MarketSide[], b: Models.MarketSide[], sort: number): Models.MarketSide[] => {
        let ret: Models.MarketSide[] = [];
        let i = 0, j = 0;
        for (i; i < a.length; i++) {
            for (j; j < b.length; j++) {
                if (a[i].price === b[j].price) {
                    if (a[i].size !== 0) {
                        ret.push(a[i]);
                    }
                    j++;
                    break;
                } else if (a[i].price * sort < b[j].price * sort) {
                    ret.push(b[j]);
                } else if (a[i].price * sort > b[j].price * sort) {
                    if (a[i].size > 0) {
                        ret.push(a[i]);
                    }
                    break;
                }
            }
        }
        return ret;
    };
    private onDepthUpdate = (depth: Models.Timestamped<OkCoinDepthMessage>) => {
        let depthData = depth.data;
        let bidsUpdate = _(depthData.bids).map(OkCoinMarketDataGateway.GetLevel).value();
        let asksUpdate = _(depthData.asks).map(OkCoinMarketDataGateway.GetLevel).value();

        let newBids: Models.MarketSide[] = this.merge(bidsUpdate, this._market.bids, 1);
        let newAsks: Models.MarketSide[] = this.merge(asksUpdate, this._market.asks, 1);

        if (this._socket.checksum(newBids, newAsks, depthData.checksum)) {
            let mkt = new Models.Market(newBids, newAsks, depth.time);
            this.MarketData.trigger(mkt);
        } else {
            let depthChannel = ["spot/depth:" + this._symbolProvider.symbol];
            this._socket.send("unsubscribe", depthChannel);
        }
    };
    private _log = log("tribeca:gateway:OkCoinMD");
    constructor(private _socket: OkCoinWebsocket, private _symbolProvider: OkCoinSymbolProvider) {

        let depthChannel = ["spot/depth:" + _symbolProvider.symbol];
        let tradesChannel = ["spot/trade:" + _symbolProvider.symbol];

        this._log.info({ "depth channel": depthChannel, "trades channel": tradesChannel }, "Constructing OkCoinMarketDataGateway!");

        _socket.setHandler("spot/depth", this.onDepth);
        _socket.setHandler("spot/depthUpdate", this.onDepthUpdate);
        _socket.setHandler("spot/trade", this.onTrade);
        // Note：_socket.ConnectChanged VS. this.ConnectChanged
        _socket.ConnectChanged.on(cs => {
            this.ConnectChanged.trigger(cs);
            if (cs == Models.ConnectivityStatus.Connected) {
                _socket.send("subscribe", depthChannel);
                _socket.send("subscribe", tradesChannel);
            }
        });
    }
}

class OkCoinOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    generateClientOrderId = () => shortId.generate();

    supportsCancelAllOpenOrders = (): boolean => { return false; };
    cancelAllOpenOrders = (): Q.Promise<number> => { return Q(0); };

    public cancelsByClientOrderId = false;

    private static GetOrderType(side: Models.Side, type: Models.OrderType): string {
        if (side === Models.Side.Bid) {
            if (type === Models.OrderType.Limit) return "buy";
            if (type === Models.OrderType.Market) return "buy_market";
        }
        if (side === Models.Side.Ask) {
            if (type === Models.OrderType.Limit) return "sell";
            if (type === Models.OrderType.Market) return "sell_market";
        }
        throw new Error("unable to convert " + Models.Side[side] + " and " + Models.OrderType[type]);
    }

    // let's really hope there's no race conditions on their end -- we're assuming here that orders sent first
    // will be acked first, so we can match up orders and their acks
    private _ordersWaitingForAckQueue = [];

    sendOrder = (order: Models.OrderStatusReport) => {
        let o: Order = {
            instrument_id: this._symbolProvider.symbol,
            type: order.type === Models.OrderType.Limit ? "limit" : "market",
            side: order.side === Models.Side.Bid ? "buy" : "sell",
            client_oid: order.orderId,
        };
        if (order.type === Models.OrderType.Limit) {
            o.size = order.quantity.toString();
            o.price = order.price.toString();
        } else if (order.side === Models.Side.Ask) {
            o.size = order.quantity.toString();
            o.price = order.price.toString();
        } else if (order.side === Models.Side.Bid) {
            o.notional = order.quantity.toString();
        }
        let jsonString = JSON.stringify(o);
        this._ordersWaitingForAckQueue.push(order.orderId);


        this._http.post("/api/spot/v3/orders", jsonString).then(msg => {
            let orderAcceptTime = Utils.date();

            // TODO: Check If this is MUST.
            // this.OrderUpdate.trigger({
            //     orderId: order.orderId,
            //     computationalLatency: Utils.fastDiff(orderAcceptTime, order.time)
            // });

            let orderResult: Models.Timestamped<OrderAck> = {
                data: {
                    result: (<any>msg.data).result,
                    order_id: (<any>msg.data).order_id
                },
                time: orderAcceptTime
            };
            this.onOrderAck(orderResult);
        }).done();
    };

    private onOrderAck = (ts: Models.Timestamped<OrderAck>) => {
        let orderId = this._ordersWaitingForAckQueue.shift();
        if (typeof orderId === "undefined") {
            this._log.error("got an order ack when there was no order queued!", util.format(ts.data));
            return;
        }

        let osr: Models.OrderStatusUpdate = { orderId: orderId, time: ts.time };

        if (ts.data.result === "true") {
            osr.exchangeId = ts.data.order_id.toString();
            osr.orderStatus = Models.OrderStatus.Working;
        }
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
        }
        this.OrderUpdate.trigger(osr);
    };

    cancelOrder = (cancel: Models.OrderStatusReport) => {
        let c: Cancel = {
            instrument_id: this._symbolProvider.symbol,
        };

        let jsonString = JSON.stringify(c);
        this._http.post("/api/spot/v3/orders/" + cancel.exchangeId, jsonString).then(msg => {
            let orderAcceptTime = Utils.date();

            // TODO: Check If this is MUST.
            // this.OrderUpdate.trigger({
            //     orderId: cancel.orderId,
            //     computationalLatency: Utils.fastDiff(Utils.date(), cancel.time)
            // });

            let orderResult: Models.Timestamped<OrderAck> = {
                data: {
                    result: (<any>msg.data).result,
                    order_id: (<any>msg.data).order_id
                },
                time: orderAcceptTime
            };
            this.onCancel(orderResult);
        }).done();

    };

    private onCancel = (ts: Models.Timestamped<OrderAck>) => {
        let osr: Models.OrderStatusUpdate = { exchangeId: ts.data.order_id.toString(), time: ts.time };

        if (ts.data.result === "true") {
            osr.orderStatus = Models.OrderStatus.Cancelled;
        }
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
            osr.cancelRejected = true;
        }

        this.OrderUpdate.trigger(osr);
    };

    replaceOrder = (replace: Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    };

    // TODO:
    private static getStatus(status: string): Models.OrderStatus {
        // status: -1: cancelled, 0: pending, 1: partially filled, 2: fully filled, 4: cancel request in process
        switch (status) {
            case "cancelled": return Models.OrderStatus.Cancelled;
            case "open": return Models.OrderStatus.Working;
            case "part_filled": return Models.OrderStatus.Working;
            case "filled": return Models.OrderStatus.Complete;
            case "failure": return Models.OrderStatus.Rejected;
            default: return Models.OrderStatus.Other;
        }
    }

    // TODO: Trade information can be got from BOTH websocket and RESTful API.
    private onOrderStatus = (osMsg: Models.Timestamped<OkCoinOrderStatus>) => {
        let t = osMsg.time;
        let msg: OkCoinOrderStatus = osMsg.data;

        let avgPx = parseFloat(msg.filled_notional) / parseFloat(msg.filled_size);
        let lastQty = parseFloat(msg.size) - parseFloat(msg.filled_size);
        let lastPx = parseFloat(msg.price);

        let status: Models.OrderStatusUpdate = {
            exchangeId: msg.order_id,
            orderStatus: OkCoinOrderEntryGateway.getStatus(msg.status),
            time: t,
            lastQuantity: lastQty > 0 ? lastQty : undefined,
            lastPrice: lastPx > 0 ? lastPx : undefined,
            averagePrice: avgPx > 0 ? avgPx : undefined,
            // TODO: This might be not necessary.
            pendingCancel: false,
            partiallyFilled: msg.status === "part_filled"
        };

        this.OrderUpdate.trigger(status);
    };

    private _log = log("tribeca:gateway:OkCoinOE");
    constructor(
        private _http: OkCoinHttp,
        private _socket: OkCoinWebsocket,
        private _signer: OkCoinMessageSigner,
        private _symbolProvider: OkCoinSymbolProvider) {
        let timestamp = (Date.now() / 1000).toString();
        let loginChannel = [this._signer.apiKey,
        this._signer.passphrase,
            timestamp,
        this._signer.ComputeHmac256(timestamp + "GET" + "/users/self/verify")
        ];
        let orderStatusChannel = ["spot/order:" + _symbolProvider.symbol];
        _socket.setHandler("spot/order", this.onOrderStatus);
        // Note：_socket.ConnectChanged VS. this.ConnectChanged
        _socket.ConnectChanged.on(cs => {
            this.ConnectChanged.trigger(cs);

            if (cs == Models.ConnectivityStatus.Connected) {
                if (_socket.LoggedIn) {
                    _socket.send("subscribe", orderStatusChannel);
                } else {
                    _socket.login(_signer, () => {
                        _socket.send("subscribe", orderStatusChannel);
                        this._log.info(orderStatusChannel, "subscribing orderStatusChannel");
                    });
                }
            }

            // if (cs == Models.ConnectivityStatus.Connected) {
            //     _socket.send("login", loginChannel);
            //     _socket.send("subscribe", orderStatusChannel);
            // }
        });

        // _socket.setHandler("ok_usd_realtrades", this.onOrderStatus);
        // _socket.setHandler("ok_spotusd_trade", this.onOrderAck);
        // _socket.setHandler("ok_spotusd_cancel_order", this.onCancel);

        // // Note：_socket.ConnectChanged VS. this.ConnectChanged
        // _socket.ConnectChanged.on(cs => {
        //     this.ConnectChanged.trigger(cs);
        //     if (cs === Models.ConnectivityStatus.Connected) {
        //         _socket.send("ok_usd_realtrades", _signer.signMessage({}));
        //     }
        // });
    }
}

class OkCoinMessageSigner {
    private _secretKey: string;
    private _api_key: string;
    private _passphrase?: string;

    public get apiKey(): string { return this._api_key; };
    public get passphrase(): string { return this._passphrase; };


    public signMessage = (m: SignedMessage): SignedMessage => {
        let els: string[] = [];

        if (!m.hasOwnProperty("api_key"))
            m.api_key = this._api_key;

        let keys = [];
        for (let key in m) {
            if (m.hasOwnProperty(key))
                keys.push(key);
        }
        keys.sort();

        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (m.hasOwnProperty(k))
                els.push(m[k]);
        }

        let sig = els.join("") + this._secretKey;
        m.sign = crypto.createHash("md5").update(sig).digest("hex").toString().toUpperCase();
        return m;
    };

    public ComputeHmac256 = (message: string): string => {
        return crypto.createHmac("SHA256", this._secretKey).update(message).digest("base64");
    }

    constructor(config: Config.IConfigProvider) {
        this._api_key = config.GetString("OkCoinApiKey");
        this._secretKey = config.GetString("OkCoinSecretKey");
        this._passphrase = config.GetString("OkCoinPassphrase");
    }
}

class OkCoinHttp {

    post = <T>(actionUrl: string, jsonString: string): Q.Promise<Models.Timestamped<T>> => {
        let d = Q.defer<Models.Timestamped<T>>();
        let u = url.resolve(this._baseUrl, actionUrl);
        let timestamp = Utils.date().toISOString();
        let preHash = timestamp + "POST" + actionUrl + jsonString;
        request({
            url: u,
            body: jsonString,
            headers: {
                "Content-Type": "application/json",
                "OK-ACCESS-KEY": this._signer.apiKey,
                "OK-ACCESS-SIGN": this._signer.ComputeHmac256(preHash),
                "OK-ACCESS-TIMESTAMP": timestamp,
                "OK-ACCESS-PASSPHRASE": this._signer.passphrase
            },
            method: "POST"
        }, (err, resp, body) => {
            if (err) d.reject(err);
            else {
                try {
                    let t = Utils.date();
                    let jsonObj = JSON.parse(body);
                    d.resolve(new Models.Timestamped(jsonObj, t));
                }
                catch (e) {
                    this._log.error(err, "url: %s, err: %o, body: %o", actionUrl, err, body);
                    d.reject(e);
                }
            }
        });
        return d.promise;
    }

    get = <T>(actionUrl: string): Q.Promise<Models.Timestamped<T>> => {
        let d = Q.defer<Models.Timestamped<T>>();
        let u = url.resolve(this._baseUrl, actionUrl);
        let timestamp = Utils.date().toISOString();
        let preHash = timestamp + "GET" + actionUrl;
        request({
            url: u,
            headers: {
                "Content-Type": "application/json",
                "OK-ACCESS-KEY": this._signer.apiKey,
                "OK-ACCESS-SIGN": this._signer.ComputeHmac256(preHash),
                "OK-ACCESS-TIMESTAMP": timestamp,
                "OK-ACCESS-PASSPHRASE": this._signer.passphrase
            },
            method: "GET"
        }, (err, resp, body) => {
            if (err) d.reject(err);
            else {
                try {
                    let t = Utils.date();
                    let jsonObj = JSON.parse(body);
                    d.resolve(new Models.Timestamped<any>(jsonObj, t));
                }
                catch (e) {
                    this._log.error(err, "url: %s, err: %o, body: %o", actionUrl, err, body);
                    d.reject(e);
                }
            }
        });
        return d.promise;
    }

    private _log = log("tribeca:gateway:OkCoinHTTP");
    private _baseUrl: string;
    constructor(config: Config.IConfigProvider, private _signer: OkCoinMessageSigner) {
        this._baseUrl = config.GetString("OkCoinHttpUrl");
        this._log.info({ "OkCoinHttpUrl": this._baseUrl }, "Constructing OkCoinHttp!");
    }
}

class OkCoinPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private static convertCurrency(name: string): Models.Currency {
        switch (name.toLowerCase()) {
            case "btc": return Models.Currency.BTC;
            case "eth": return Models.Currency.ETH;
            case "eos": return Models.Currency.EOS;
            case "usdt": return Models.Currency.USDT;
            case "xrp": return Models.Currency.XRP;
            case "ltc": return Models.Currency.LTC;
            case "bnb": return Models.Currency.BNB;
            case "trx": return Models.Currency.TRX;
            case "usd": return Models.Currency.USD;
            case "eur": return Models.Currency.EUR;
            case "gbp": return Models.Currency.GBP;
            case "cny": return Models.Currency.CNY;
            case "dash": return Models.Currency.DASH;
            case "okb": return Models.Currency.OKB;

            default: throw new Error("Unsupported currency " + name);
        }
    }


    private trigger = () => {
        this._http.get("/api/spot/v3/accounts").then(msg => {
            let accountArray = <Array<any>>msg.data;
            accountArray.forEach(account => {
                let available = parseFloat(account.available);
                let held = parseFloat(account.hold);
                let currency = OkCoinPositionGateway.convertCurrency(account.currency);
                let pos = new Models.CurrencyPosition(available, held, currency);
                this.PositionUpdate.trigger(pos);
            });
        }).done();
    };

    private _log = log("tribeca:gateway:OkCoinPG");
    constructor(private _http: OkCoinHttp) {
        setInterval(this.trigger, 15000);
        setTimeout(this.trigger, 10);
    }
}

class OkCoinBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() { return false; }
    name(): string { return "Okex"; }
    makeFee(): number { return 0.001; }
    takeFee(): number { return 0.002; }
    exchange(): Models.Exchange { return Models.Exchange.Okex; }
    constructor(public minTickIncrement: number) { }
}

class OkCoinSymbolProvider {
    public symbol: string;
    public symbolWithoutHyphen: string;

    constructor(pair: Models.CurrencyPair) {
        const GetCurrencySymbol = (s: Models.Currency): string => Models.fromCurrency(s);
        this.symbol = GetCurrencySymbol(pair.base) + "-" + GetCurrencySymbol(pair.quote);
        this.symbolWithoutHyphen = GetCurrencySymbol(pair.base) + GetCurrencySymbol(pair.quote);
    }
}

class OkCoin extends Interfaces.CombinedGateway {
    constructor(config: Config.IConfigProvider, pair: Models.CurrencyPair) {
        let symbol = new OkCoinSymbolProvider(pair);
        let signer = new OkCoinMessageSigner(config);
        let http = new OkCoinHttp(config, signer);
        let socket = new OkCoinWebsocket(config);

        let orderGateway = config.GetString("OkCoinOrderDestination") == "Okex"
            ? <Interfaces.IOrderEntryGateway>new OkCoinOrderEntryGateway(http, socket, signer, symbol)
            : new NullGateway.NullOrderGateway();

        super(
            new OkCoinMarketDataGateway(socket, symbol),
            orderGateway,
            new OkCoinPositionGateway(http),
            new OkCoinBaseGateway(.01)); // uh... todo
    }
}

export async function createOkCoin(config: Config.IConfigProvider, pair: Models.CurrencyPair): Promise<Interfaces.CombinedGateway> {
    return new OkCoin(config, pair);
}