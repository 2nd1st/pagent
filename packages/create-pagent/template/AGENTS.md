# __TITLE__

A pagent app: every folder with a page.tsx is a page, with its data files and, when it needs one, its own agent.

## Pages

- / — home: the conversation with the app's bot (it answers in text or with cards, and builds the app with you), and
  the cards pinned above it (pins.json).
- /cards/* — cards: small pages the bot shows inside its replies, and shows again with other props.

## Routes (the app's public face)

None yet: nothing here takes requests from outside. `api/**/route.ts` files are `/api/**` (and the same, as tools, at
`/mcp`), reachable by anyone on the network. To let other apps' agents message the bot, open its inbox with
`api/message/route.ts`: `export { inbox as POST } from "pagent/server";`. Whatever you put there, look at `caller`
(who is asking) first.
