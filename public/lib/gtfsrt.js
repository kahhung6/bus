(function (root, factory) {
  // Works in both places: Node (require) and the browser (<script> tag -> window.PenangLib.<name>).
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PenangLib = root.PenangLib || {}; root.PenangLib.gtfsrt = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
/**
 * gtfsrt.js - a tiny decoder for the GTFS-Realtime "VehiclePosition" feed.
 *
 * WHY THIS EXISTS
 * The realtime API returns binary data in Google's "protobuf" format, not JSON.
 * Normally you'd use the `gtfs-realtime-bindings` npm package. This file does the same job
 * for just the fields we need, so the project has no dependencies.
 *
 * HOW PROTOBUF WORKS (the 30-second version)
 * A message is a flat run of "fields". Each field starts with a number called the TAG:
 *      tag = (fieldNumber << 3) | wireType
 * - fieldNumber says WHICH field it is (defined in gtfs-realtime.proto, e.g. latitude = 1).
 * - wireType says HOW the value is stored:
 *      0 = varint (a whole number stored in 1-10 bytes, 7 bits per byte)
 *      1 = 8 fixed bytes (e.g. a double)
 *      2 = length-delimited (a length number, then that many bytes: a string or a nested message)
 *      5 = 4 fixed bytes (e.g. a float)
 * Nested messages are just length-delimited bytes that we decode again with the same method.
 */

// The wire types listed above, named so the code below reads clearly.
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/**
 * Creates a "reader" that walks through a byte array from left to right.
 * `cursor` is the position of the next unread byte; every read method moves it forward.
 */
function createByteReader(bytes) {
  let cursor = 0;
  // DataView lets us read raw bytes as a float number.
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    /** true while there are unread bytes left */
    hasMore: () => cursor < bytes.length,

    /**
     * Reads a "varint": each byte holds 7 bits of the number, and the top bit (128) means
     * "another byte follows". Bytes come least-significant first, so we multiply by 128 each time.
     * (We multiply instead of using bit-shifts because JavaScript bit-shifts only work on 32-bit
     * numbers, and a varint can be larger than that.)
     */
    readVarint() {
      let value = 0;
      let multiplier = 1;
      let byte;
      do {
        byte = bytes[cursor++];
        value += (byte & 0x7f) * multiplier; // take the low 7 bits
        multiplier *= 128;
      } while (byte & 0x80); // keep going while the "more bytes" bit is set
      return value;
    },

    /** Reads 4 bytes as a 32-bit float (used for latitude, longitude, bearing, speed). */
    readFloat32() {
      const value = dataView.getFloat32(cursor, true); // true = little-endian
      cursor += 4;
      return value;
    },

    /** Reads a length number, then returns that many bytes (a string, or a nested message). */
    readLengthDelimitedBytes() {
      const length = this.readVarint();
      const slice = bytes.subarray(cursor, cursor + length);
      cursor += length;
      return slice;
    },

    /** Skips a field we don't care about, so unknown fields can't break decoding. */
    skipField(wireType) {
      if (wireType === WIRE_VARINT) this.readVarint();
      else if (wireType === WIRE_FIXED64) cursor += 8;
      else if (wireType === WIRE_LENGTH_DELIMITED) this.readLengthDelimitedBytes();
      else if (wireType === WIRE_FIXED32) cursor += 4;
      else throw new Error('Unsupported protobuf wire type ' + wireType);
    },
  };
}

/** Turns raw bytes into a JS string (protobuf strings are UTF-8). */
const utf8Decoder = new TextDecoder('utf-8'); // available in both Node and browsers
const bytesToString = (bytes) => utf8Decoder.decode(bytes);

/** Splits a tag number into its two halves (see the explanation at the top of the file). */
function splitTag(tag) {
  return { fieldNumber: tag >> 3, wireType: tag & 7 };
}

/** TripDescriptor: which scheduled trip the bus says it is running. */
function parseTripDescriptor(bytes) {
  const reader = createByteReader(bytes);
  const trip = {};
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = splitTag(reader.readVarint());
    if (fieldNumber === 1 && wireType === WIRE_LENGTH_DELIMITED) trip.tripId = bytesToString(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 2 && wireType === WIRE_LENGTH_DELIMITED) trip.startTime = bytesToString(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 3 && wireType === WIRE_LENGTH_DELIMITED) trip.startDate = bytesToString(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 5 && wireType === WIRE_LENGTH_DELIMITED) trip.routeId = bytesToString(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 6 && wireType === WIRE_VARINT) trip.directionId = reader.readVarint();
    else reader.skipField(wireType);
  }
  return trip;
}

/** Position: where the bus is. Speed is in metres per second. */
function parsePosition(bytes) {
  const reader = createByteReader(bytes);
  const position = {};
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = splitTag(reader.readVarint());
    if (fieldNumber === 1 && wireType === WIRE_FIXED32) position.lat = reader.readFloat32();
    else if (fieldNumber === 2 && wireType === WIRE_FIXED32) position.lon = reader.readFloat32();
    else if (fieldNumber === 3 && wireType === WIRE_FIXED32) position.bearingDegrees = reader.readFloat32();
    else if (fieldNumber === 5 && wireType === WIRE_FIXED32) position.speedMetersPerSecond = reader.readFloat32();
    else reader.skipField(wireType);
  }
  return position;
}

/** VehicleDescriptor: identifies the physical bus (id, label, number plate). */
function parseVehicleDescriptor(bytes) {
  const reader = createByteReader(bytes);
  const vehicleInfo = {};
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = splitTag(reader.readVarint());
    if (fieldNumber === 1 && wireType === WIRE_LENGTH_DELIMITED) vehicleInfo.id = bytesToString(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 2 && wireType === WIRE_LENGTH_DELIMITED) vehicleInfo.label = bytesToString(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 3 && wireType === WIRE_LENGTH_DELIMITED) vehicleInfo.licensePlate = bytesToString(reader.readLengthDelimitedBytes());
    else reader.skipField(wireType);
  }
  return vehicleInfo;
}

/** VehiclePosition: everything the feed says about one bus right now. */
function parseVehiclePosition(bytes) {
  const reader = createByteReader(bytes);
  const vehiclePosition = {};
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = splitTag(reader.readVarint());
    if (fieldNumber === 1 && wireType === WIRE_LENGTH_DELIMITED) vehiclePosition.trip = parseTripDescriptor(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 2 && wireType === WIRE_LENGTH_DELIMITED) Object.assign(vehiclePosition, parsePosition(reader.readLengthDelimitedBytes()));
    else if (fieldNumber === 3 && wireType === WIRE_VARINT) vehiclePosition.currentStopSequence = reader.readVarint();
    else if (fieldNumber === 4 && wireType === WIRE_VARINT) vehiclePosition.currentStatus = reader.readVarint(); // 0 arriving, 1 stopped, 2 in transit
    else if (fieldNumber === 5 && wireType === WIRE_VARINT) vehiclePosition.timestamp = reader.readVarint(); // unix seconds
    else if (fieldNumber === 6 && wireType === WIRE_VARINT) vehiclePosition.congestionLevel = reader.readVarint();
    else if (fieldNumber === 7 && wireType === WIRE_LENGTH_DELIMITED) vehiclePosition.stopId = bytesToString(reader.readLengthDelimitedBytes());
    else if (fieldNumber === 8 && wireType === WIRE_LENGTH_DELIMITED) vehiclePosition.vehicle = parseVehicleDescriptor(reader.readLengthDelimitedBytes());
    else reader.skipField(wireType);
  }
  return vehiclePosition;
}

/**
 * Decodes a whole feed.
 * Layout: FeedMessage { header (field 1), entity[] (field 2) }
 *         FeedEntity  { id (field 1), vehicle (field 4) }
 * @param {Uint8Array} bytes the raw HTTP response body
 * @returns {{ feedTimestamp: number, vehicles: object[] }}
 */
function parseFeed(bytes) {
  const reader = createByteReader(bytes);
  const vehicles = [];
  let feedTimestamp = 0; // when the feed itself was generated (unix seconds)

  while (reader.hasMore()) {
    const { fieldNumber, wireType } = splitTag(reader.readVarint());

    if (fieldNumber === 1 && wireType === WIRE_LENGTH_DELIMITED) {
      // Header: we only want its timestamp (field 3)
      const headerReader = createByteReader(reader.readLengthDelimitedBytes());
      while (headerReader.hasMore()) {
        const headerTag = splitTag(headerReader.readVarint());
        if (headerTag.fieldNumber === 3 && headerTag.wireType === WIRE_VARINT) feedTimestamp = headerReader.readVarint();
        else headerReader.skipField(headerTag.wireType);
      }
    } else if (fieldNumber === 2 && wireType === WIRE_LENGTH_DELIMITED) {
      // Entity: one per bus; the bus data is in its "vehicle" field (4)
      const entityReader = createByteReader(reader.readLengthDelimitedBytes());
      while (entityReader.hasMore()) {
        const entityTag = splitTag(entityReader.readVarint());
        if (entityTag.fieldNumber === 4 && entityTag.wireType === WIRE_LENGTH_DELIMITED) {
          vehicles.push(parseVehiclePosition(entityReader.readLengthDelimitedBytes()));
        } else entityReader.skipField(entityTag.wireType);
      }
    } else reader.skipField(wireType);
  }

  // Drop entries that have no GPS position - we can't show those on a map.
  return { feedTimestamp, vehicles: vehicles.filter((v) => v.lat != null && v.lon != null) };
}

return { parseFeed };
});
