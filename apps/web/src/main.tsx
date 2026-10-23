import React from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from '@sync/bindings';
import { env } from './lib/env';
import { App } from './app/App';
import './styles/index.css';
const key = `sync-token:${env.VITE_SPACETIMEDB_URI}:${env.VITE_SPACETIMEDB_DATABASE}`;
const builder = DbConnection.builder()
  .withUri(env.VITE_SPACETIMEDB_URI)
  .withDatabaseName(env.VITE_SPACETIMEDB_DATABASE)
  .withToken(localStorage.getItem(key) ?? undefined)
  .onConnect((_conn, _identity, token) => localStorage.setItem(key, token));
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SpacetimeDBProvider connectionBuilder={builder}>
      <App />
    </SpacetimeDBProvider>
  </React.StrictMode>,
);
