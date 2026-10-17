// Moving between pages of the app inside the shell (links, an agent's `pagent screen open`): the bridge's navigate,
// the same one pages call, so history counts the pages of the app the same way (the shell offers "back" by it).
export { navigate as go } from "@pagent/bridge";
