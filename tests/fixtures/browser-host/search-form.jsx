import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

function SearchForm() {
  const [query, setQuery] = useState('');
  return <form action="/results">
    <input name="q" aria-label="Name" value={query} onChange={event => setQuery(event.target.value)}/>
    <button disabled={!query}>Submit</button>
  </form>;
}

createRoot(document.querySelector('main')).render(<SearchForm/>);
