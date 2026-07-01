# Client Popup

Use the client helper when you want a simple browser popup after receiving a decision.

```ts
import { showBotDetectedPopup } from "noskrap/client";

showBotDetectedPopup(result);
```

By default, the helper shows `"Bot detected."` for `challenge` and `block`.

## Custom message

```ts
showBotDetectedPopup(result, {
  message: "Suspicious traffic detected.",
});
```

## Custom renderer

Use `show` to replace `alert()` with your own toast or modal.

```ts
showBotDetectedPopup(result, {
  show: (message) => {
    toast.error(message);
  },
});
```

## Decision input

The helper accepts either a decision string or an object with a `decision` field.

```ts
showBotDetectedPopup("block");
showBotDetectedPopup({ decision: "challenge" });
```
