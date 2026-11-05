"""Tool schemas for wheelspin — what the model sees."""

LOAD = {
    "description": (
        "Load a list of options onto a visual spinning wheel in the Hermes Desktop app. "
        "Use this whenever the user wants to decide between things at random (what to eat, "
        "which game to play, who goes first, which task to pick up) or explicitly asks for "
        "the wheel. The user then clicks TRY YOUR LUCK in the Wheel pane, the wheel animates, "
        "and the winning label is announced. Calling this tool does not pick a winner by itself. "
        "The result carries a `display` field: copy it exactly into one fenced code block, "
        "character for character, so the wheel is visible in text-only surfaces. If the user wants an instant answer "
        "without the animation, use wheelspin_spin instead."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Short name for the wheel, e.g. 'dinner' or 'next game'. Defaults to 'wheel'.",
            },
            "items": {
                "type": "array",
                "description": "The options. Plain strings, or objects with a label and an optional integer weight (higher weight = more likely).",
                "items": {
                    "anyOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "weight": {"type": "integer", "minimum": 1, "maximum": 1000},
                            },
                            "required": ["label"],
                        },
                    ]
                },
            },
            "mode": {
                "type": "string",
                "enum": ["replace", "append"],
                "description": "replace (default) overwrites the wheel; append adds these options to an existing wheel of the same name.",
            },
            "source": {
                "type": "string",
                "description": "Optional note on where the list came from, e.g. 'Steam library' or 'user message'.",
            },
        },
        "required": ["items"],
        "additionalProperties": False,
    },
}

SPIN = {
    "description": (
        "Draw an answer immediately from a loaded wheel, without the Desktop animation. "
        "Returns the winning label(s) and their probabilities, plus a `display` field holding "
        "the wheel already drawn in block characters. Copy the `display` field into your reply "
        "EXACTLY, character for character, inside ONE fenced code block: do not trim, re-align, "
        "reflow, re-wrap or summarise it. That drawing is the only way the user sees the wheel "
        "in the CLI, TUI, Discord or any gateway chat. Use this when the user asks "
        "you to just pick something, when the Desktop app is not in use, or when they want "
        "several draws in a row. If no wheel is loaded it picks from the items passed here."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Which loaded wheel to draw from. Defaults to the most recently loaded wheel.",
            },
            "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "How many independent draws to make. Default 1.",
            },
            "items": {
                "type": "array",
                "description": "Optional throwaway list to load and spin in one step when no wheel is loaded.",
                "items": {"anyOf": [{"type": "string"}, {"type": "object"}]},
            },
        },
        "additionalProperties": False,
    },
}

LIST = {
    "description": (
        "List the wheels currently loaded in WheelSpin, with item counts, total weight and the "
        "most recent spin results. Use this to recall what a wheel contains before spinning it, "
        "or when the user asks what is on the wheel."
    ),
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}

DELETE = {
    "description": "Remove a loaded wheel by name. Does not affect the Desktop UI beyond it disappearing from the picker.",
    "parameters": {
        "type": "object",
        "properties": {"name": {"type": "string", "description": "Wheel name to remove."}},
        "required": ["name"],
        "additionalProperties": False,
    },
}
