/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-timeshift.ts: UniFi Protect livestream timeshift buffer implementation to support HomeKit Secure Video.
 */
import { HomebridgePluginLogging, sleep } from "homebridge-plugin-utils";
import { ProtectCamera, ProtectCameraPackage } from "./devices/index.js";
import { EventEmitter } from "node:events";
import { PROTECT_HKSV_SEGMENT_RESOLUTION } from "./settings.js";
import { PlatformAccessory } from "homebridge";
import { ProtectLivestream } from "unifi-protect";
import { ProtectNvr } from "./protect-nvr.js";

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter {

  private _buffer: Buffer[];
  private _channel: number;
  private _isStarted: boolean;
  private _isTransmitting: boolean;
  private _lens: number | undefined;
  private _segmentLength: number;
  private readonly accessory: PlatformAccessory;
  private bufferSize: number;
  private livestream: ProtectLivestream | null;
  private readonly log: HomebridgePluginLogging;
  private readonly nvr: ProtectNvr;
  private readonly protectCamera: ProtectCamera;
  private eventHandlers: { [index: string]: ((segment: Buffer) => void) | (() => void) };

  constructor(protectCamera: ProtectCamera) {

    // Initialize the event emitter.
    super();

    this._buffer = [];
    this._isStarted = false;
    this._isTransmitting = false;
    this.accessory = protectCamera.accessory;
    this.bufferSize = 1;
    this._channel = 0;
    this.eventHandlers = {};
    this._lens = (protectCamera instanceof ProtectCameraPackage) ? protectCamera.ufp.lenses[0].id : undefined;
    this.livestream = null;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;

    // We use a small value for segment resolution in our timeshift buffer to ensure we provide an optimal timeshifting experience. It's a very small amount of additional
    // overhead for modern CPUs, but the result is a much better HKSV event recording experience.
    this._segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION;

    this.eventHandlers.segment = (segment: Buffer): void => {

      // Add the livestream segment to the end of the timeshift buffer.
      this._buffer.push(segment);

      // At a minimum we always want to maintain a single segment in our buffer.
      if(this.bufferSize <= 0) {

        this.bufferSize = 1;
      }

      // Trim the beginning of the buffer to our configured size unless we are transmitting to HomeKit, in which case, we queue up all the segments for consumption.
      if(!this.isTransmitting && (this._buffer.length >  this.bufferSize)) {

        this._buffer.shift();
      }

      // If we're transmitting, we want to send all the segments we can so FFmpeg can consume it.
      if(this.isTransmitting) {

        this.transmit();
      }
    };
  }

  // Configure the timeshift buffer.
  private configureTimeshiftBuffer(): void {

    // If the livestream API has closed, stop what we're doing. XXX -- LEAK HERE AT CLOSE
    this.livestream?.on("close", this.eventHandlers.close = (): void => {

      this.log.error("The livestream API connection was unexpectedly closed by the Protect controller: " +
        "this is typically due to device restarts or issues with Protect controller firmware versions, and can be safely ignored. Will retry again shortly.");
      this.stop();
    });

    // First, we need to listen for any segments sent by the UniFi Protect livestream in order to create our timeshift buffer.
    this.livestream?.on("segment", this.eventHandlers.segment);
  }

  // Start the livestream and begin maintaining our timeshift buffer.
  public async start(channelId = this._channel, lens = this._lens): Promise<boolean> {

    // If we're using a secondary lens, the channel must always be 0.
    if(lens !== undefined) {

      channelId = 0;
    }

    // Stop the timeshift buffer if it's already running.
    if(this.isStarted) {

      this.stop();
    }

    // Ensure we have sane values configured for the segment resolution. We check this here instead of in the constructor because we may not have an HKSV recording
    // configuration available to us immediately upon startup.
    if(this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength) {

      if((this.segmentLength < 100) || (this.segmentLength > 1500) ||
        (this.segmentLength > (this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength / 2))) {

        this._segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION;
      }
    }

    // Clear out the timeshift buffer, if it's been previously filled, and then fire up the timeshift buffer.
    this._buffer = [];

    // Acquire our livestream.
    this.livestream = this.protectCamera.livestream.acquire(channelId, lens);

    // Something went wrong.
    if(!this.livestream) {

      return false;
    }

    // Setup our listeners.
    this.configureTimeshiftBuffer();

    // Start the livestream and let's begin building our timeshift buffer.
    if(!(await this.protectCamera.livestream.start(channelId, lens, this.segmentLength))) {

      return false;
    }

    this._channel = channelId;
    this._lens = lens;
    this._isStarted = true;

    return true;
  }

  // Stop timeshifting the livestream.
  public stop(): boolean {

    if(this.isStarted) {

      // Stop the livestream and remove the listeners.
      this.protectCamera.livestream.stop(this._channel, this._lens);
      Object.keys(this.eventHandlers).map(eventName => this.livestream?.off(eventName, this.eventHandlers[eventName]));
    }

    this._buffer = [];
    this._isStarted = false;

    return true;
  }

  // Start transmitting our timeshift buffer.
  public async transmitStart(): Promise<boolean> {

    // If we haven't started the livestream, or it was closed for some reason, let's start it now.
    if(!this.isStarted && !(await this.start())) {

      this.log.error("Unable to access the Protect livestream API: this is typically due to the Protect controller or camera rebooting. Will retry again.");

      await this.nvr.resetNvrConnection();

      return false;
    }

    // Add the initialization segment to the beginning of the timeshift buffer, if we have it. If we don't, FFmpeg will still be able to generate a valid fMP4 stream,
    // albeit a slightly less elegantly.
    const initSegment = await this.getInitSegment();

    if(initSegment) {

      this._buffer.unshift(initSegment);
    } else {

      this.log.error("Unable to begin transmitting the stream to HomeKit Secure Video: unable to retrieve initialization data from the UniFi Protect controller. " +
        "This error is typically due to either an issue connecting to the Protect controller, or a problem on the Protect controller.");

      await this.nvr.resetNvrConnection();

      return false;
    }

    // Transmit everything we have queued up to get started as quickly as possible.
    this.transmit();

    // Let our livestream listener know that we're now transmitting.
    this._isTransmitting = true;

    return true;
  }

  // Stop transmitting our timeshift buffer.
  public transmitStop(): boolean {

    // We're done transmitting, flag it, and allow our buffer to resume maintaining itself.
    this._isTransmitting = false;

    return true;
  }

  // Transmit the contents of our timeshift buffer.
  private transmit(): void {

    this.emit("segment", Buffer.concat(this._buffer));
    this._buffer = [];
  }

  // Check if this is the fMP4 initialization segment.
  public isInitSegment(segment: Buffer): boolean {

    if(this.livestream?.initSegment?.equals(segment)) {

      return true;
    }

    return false;
  }

  // Get the fMP4 initialization segment from the livestream API.
  public async getInitSegment(): Promise<Buffer | null> {

    // If we have the initialization segment, return it.
    if(this.livestream?.initSegment) {

      return this.livestream.initSegment;
    }

    // We haven't seen it yet, wait for a couple of seconds and check an additional time.
    await sleep(2000);

    // We either have it or we don't - we can't afford to wait too long for this - HKSV is time-sensitive and we need to ensure we have a reasonable upper bound on how
    // long we wait for data from the Protect API.
    return this.livestream?.initSegment ?? null;
  }

  // Return the last duration milliseconds of the buffer, with an initialization segment.
  public getLast(duration: number): Buffer | null {

    // Figure out where in the timeshift buffer we want to slice.
    const start = (duration / this.segmentLength);

    // We're really trying to get the whole buffer, so let's do that.
    if(start >= this._buffer.length) {

      return this.buffer;
    }

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the duration requested, starting from the end.
    return (this.livestream?.initSegment && this._buffer.length) ? Buffer.concat([ this.livestream.initSegment, ...this._buffer.slice(start)]) : null;
  }

  // Return the current timeshift buffer, in full.
  public get buffer(): Buffer | null {

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the current timeshift buffer in full.
    return (this.livestream?.initSegment && this._buffer.length) ? Buffer.concat([ this.livestream.initSegment, ...this._buffer ]) : null;
  }

  public get channel(): number {

    return this._channel;
  }

  public get lens(): number | undefined {

    return this._lens;
  }

  // Return whether or not we have started the timeshift buffer.
  public get isStarted(): boolean {

    return this._isStarted;
  }

  // Return whether we are transmitting our timeshift buffer or not.
  public get isTransmitting(): boolean {

    return this._isTransmitting;
  }

  // Retrieve the current size of the timeshift buffer, in milliseconds.
  public get length(): number {

    return (this.bufferSize * this.segmentLength);
  }

  // Set the size of the timeshift buffer, in milliseconds.
  public set length(bufferMillis: number) {

    // Calculate how many segments we need to keep in order to have the appropriate number of seconds in our buffer.
    this.bufferSize = bufferMillis / this.segmentLength;
  }

  // Return the recording length, in milliseconds, of an individual segment.
  public get segmentLength(): number {

    return this._segmentLength;
  }
}
