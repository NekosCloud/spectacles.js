import * as amqp from 'amqplib';
import { ulid } from 'ulid';
const { isFatalError } = require('amqplib/lib/connection');
import Broker, { ResponseOptions, Options } from './Base';

export interface AmqpOptions<T = any> extends Options<T> {
  reconnectTimeout?: number;
  consume?: amqp.Options.Consume,
  assert?: amqp.Options.AssertQueue,
}

export interface AmqpResponseOptions extends ResponseOptions {
  ack: () => void;
  nack: (allUpTo?: boolean, requeue?: boolean) => void;
  reject: (requeue?: boolean) => void;
}

/**
 * A broker for AMQP clients. Probably most useful for RabbitMQ.
 * @extends Broker
 */
export default class Amqp<T = any> extends Broker<T, AmqpResponseOptions> {
  /**
   * The AMQP channel currently connected to.
   * @type {?amqp.Channel}
   */
  public channel?: amqp.Channel;

  /**
   * The callback queue.
   * @type {?string}
   */
  public callback?: string;

  /**
   * The AMQP exchange of this broker.
   * @type {string}
   */
  public group: string;

  /**
   * The subgroup of this broker. Useful to setup multiple groups of queues that all receive the same data.
   * Implemented internally as an extra identifier in the queue name.
   * @type {string}
   */
  public subgroup?: string;

  public options: AmqpOptions<T>;

  /**
   * The consumers that this broker has registered.
   * @type {Object<string, string>}
   * @private
   */
  private _consumers: { [event: string]: string };

  /**
   * @constructor
   * @param {Client} client The client of this broker
   * @param {string} [group='default'] The group of this broker
   * @param {string} [subgroup] The {@link Amqp#subgroup} of this broker
   * @param {Object} [options={}] Options for constructing this broker
   * @param {boolean} [options.rpc=false] Whether this broker is in RPC mode (causes the {@link Amqp#publish}
   * method to wait for a response before resolving)
   * @param {number} [options.reconnectTimeout=1e4] How often to attempt to reconnect when the connection fails.
   */
  constructor(group?: string, options?: AmqpOptions<T>);
  constructor(group?: string, subgroup?: string, options?: AmqpOptions<T>);
  constructor(group: string = 'default', subgroup?: AmqpOptions<T> | string, options?: AmqpOptions<T>) {
    if (typeof subgroup === 'object') {
      super(subgroup);
      this.options = subgroup;
    } else {
      super(options);
      this.subgroup = subgroup;
      this.options = options ?? {};
    }

    this.group = group;
    this._consumers = {};
  }

  /**
   * Connect this broker to your AMQP client.
   * @param {string} url The URL of your AMQP client
   * @param {?*} options Options to connect to the AMQP client
   * @returns {Promise<void>}
   */
  public async connect(urlOrConn: string | amqp.Connection, options?: any): Promise<amqp.Connection> {
    let connection: amqp.Connection | undefined;
    if (typeof urlOrConn !== 'string') connection = urlOrConn;

    while (!connection) {
      try {
        connection = await amqp.connect(`amqp://${urlOrConn}`, options);
      } catch (e) {
        this.emit('close', e);
        await new Promise(r => setTimeout(r, this.options.reconnectTimeout));
        continue;
      }

      connection.on('close', (err) => {
        if (!isFatalError(err)) {
          this.emit('close', err);
          setTimeout(() => this.connect(urlOrConn, options), this.options.reconnectTimeout);
        }
      });

      connection.on('error', (err) => {
        this.emit('error', err);
      });
    }

    this.channel = await connection.createChannel();

    // setup RPC callback queue
    this.callback = (await this.channel.assertQueue('', { exclusive: true })).queue;
    this.channel.consume(this.callback, (msg) => {
      if (msg) this._handleReply(msg.properties.correlationId, msg.content);
    }, { noAck: true });

    await this.channel.assertExchange(this.group, 'direct');
    return connection;
  }

  public async createQueue(event: string): Promise<string> {
    const queue = `${this.group}:${(this.subgroup ? `${this.subgroup}:` : '') + event}`;
    await this._channel.assertQueue(queue, this.options.assert);
    await this._channel.bindQueue(queue, this.group, event);
    return queue;
  }

  /**
   * Subscribe this broker to some AMQP queues.
   * @param {string|Iterable<string>} events The events to subscribe to
   * @param {Object} [options={}] The connection options
   * @param {amqp.Options.Consume} [options.consume] Options to pass to the consumer
   * @param {amqp.Options.AssertQueue} [options.assert] Options to pass to the queue assertion
   * @returns {Promise<amqp.Replies.Consume[]>}
   */
  protected _subscribe(events: string[]): Promise<amqp.Replies.Consume[]> {
    return Promise.all(events.map(async event => {
      const queue = await this.createQueue(event);

      // register consumer
      const consumer = await this._channel.consume(queue, async msg => {
        // emit consumed messages with an acknowledger function
        if (msg) {
          try {
            this._handleMessage(event, msg.content, {
              reply: (data) => this._channel.sendToQueue(msg.properties.replyTo, this.serialize(data), { correlationId: msg.properties.correlationId }),
              ack: () => this._channel.ack(msg),
              nack: (allUpTo, requeue) => this._channel.nack(msg, allUpTo, requeue),
              reject: (requeue) => this._channel.reject(msg, requeue),
            });
          } catch (e) {
            this._channel.reject(msg, false);
            this.emit('error', e);
          }
        }
      }, this.options.consume);

      this._consumers[event] = consumer.consumerTag;
      return consumer;
    }));
  }

  /**
   * Unsubscribe this broker from some AMQP queues.
   * @param {string | string[]} events The channels to unsubscribe from
   * @returns {Promise<Array<undefined>>}
   */
  protected _unsubscribe(events: string[]): Promise<boolean[]> {
    return Promise.all(events.map(async event => {
      if (this._consumers[event]) {
        await this._channel.cancel(this._consumers[event]);
        delete this._consumers[event];
        return true;
      }

      return false;
    }))
  }

  /**
   * Publish an event to the AMQP broker.
   * @param {string} event The event to publish
   * @param {*} data The data to publish
   * @param {amqp.Options.Publish} [options={}] AMQP publish options
   */
  public publish(event: string, data: T, options: amqp.Options.Publish = {}): void {
    this._channel.publish(this.group, event, this.serialize(data), options);
  }

  public call(method: string, data: T, options: amqp.Options.Publish = {}): Promise<unknown> {
    const correlation = ulid();
    this.publish(method, data, Object.assign(options, {
      replyTo: this.callback,
      correlationId: correlation,
    }));

    return this._awaitResponse(correlation, typeof options.expiration === 'string' ? parseInt(options.expiration, 10) : options.expiration);
  }

  /**
   * Convenience accessor for the AMQP channel.
   * @throws {Error} When the channel doesn't exist
   * @returns {amqp.Channel} The AMQP channel.
   * @protected
   */
  protected get _channel(): amqp.Channel {
    if (!this.channel) throw new Error('no available amqp channel');
    return this.channel;
  }
}
