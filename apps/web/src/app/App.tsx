import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '@sync/bindings';
/** Integration placeholder: real subscription status, no seeded data or mutations. */
export function App() {
  const connection = useSpacetimeDB();
  const [, ready] = useTable(tables.uiRuns);
  return (
    <main>
      <p>SYNC · Integration handoff</p>
      <h1>Coffee-shop workflow</h1>
      <p>Dashboard implementation pending.</p>
      <section>
        <h2>SpacetimeDB</h2>
        <p>
          {connection.isActive && ready
            ? 'Connected · authorized run subscription applied'
            : 'Waiting for database connection and subscription'}
        </p>
        {connection.connectionError && (
          <p role="alert">{String(connection.connectionError)}</p>
        )}
        <button onClick={() => location.reload()}>Reconnect</button>
      </section>
      <p>
        Use the generated ui* views and reducers from @sync/bindings. No orders
        are created automatically.
      </p>
    </main>
  );
}
