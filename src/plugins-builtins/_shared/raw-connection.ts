import type { Connection } from 'mysql2/promise';

type ColumnPacket = {
  name: string;
};

type QueryEvents = {
  fields: (fields: ColumnPacket[] | undefined) => void;
  result: (row: unknown) => void;
  error: (error: Error) => void;
  end: () => void;
};

type StreamingQuery = {
  on: <Event extends keyof QueryEvents>(event: Event, listener: QueryEvents[Event]) => StreamingQuery;
};

type RawConnection = {
  query: (options: { sql: string; rowsAsArray: boolean; timeout: number | undefined }) => StreamingQuery;
  stream: { destroy: () => void; unref?: () => void };
};

function isRawConnection(value: unknown): value is RawConnection {
  return (
    typeof value === 'object' &&
    value !== null &&
    'query' in value &&
    typeof value.query === 'function' &&
    'stream' in value &&
    typeof value.stream === 'object' &&
    value.stream !== null &&
    'destroy' in value.stream &&
    typeof value.stream.destroy === 'function'
  );
}

export function rawConnectionOf(conn: Connection): RawConnection {
  const raw: unknown = Reflect.get(conn, 'connection');
  if (!isRawConnection(raw)) {
    throw new Error('mysql2 connection does not expose its raw connection');
  }
  return raw;
}
