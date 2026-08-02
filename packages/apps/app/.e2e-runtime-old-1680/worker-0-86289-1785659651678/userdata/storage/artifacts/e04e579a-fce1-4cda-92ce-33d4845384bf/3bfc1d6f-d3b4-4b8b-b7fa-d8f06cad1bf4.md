# AI Provider Tycoon — Player State

The complete schema of every property stored on a player / organisation. Drives:
- What the agent sees in its self-state input.
- What is exposed to other players (public state).
- What gets persisted in the event log and replayed.

## Property structure

Each property is documented as:

| Field | Description |
|---|---|
| **Name** | Identifier used in code and the agent's input. |
| **Type** | `int`, `float`, `string`, `enum`, `list<...>`, `map<...>`, `boolean`. |
| **Allowed values / range** | Constraints (e.g. `≥ 0`, enum members, length cap). |
| **Visibility** | `public` (visible to all players) or `private` (only the owner). |
| **Mutable by** | `agent` (set via an action), `simulation` (set by mechanics), or `both`. |
| **Description** | Brief semantic note. |

***

## Properties

*To be filled in.*

### Cash & finance

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

### Capacity

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

### Brand

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

### Models

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

### Research

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

### Operations

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

### Spending lines (burn-rate components)

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

### Inbox / pending state

| Name | Type | Range | Visibility | Mutable by | Description |
|---|---|---|---|---|---|
| | | | | | |

***

## Open

- Fill in every property.
- Once schema is defined, the **Self state structure**, **Competitor public state structure**, and **Event history window** plan rows can be answered from this asset.
