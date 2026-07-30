# Search API ICP

An Exa-style, high-volume JSON search API. Public requests stay cacheable;
feedback-aware agent requests send `Agent-Feedback-Request: 1` and receive a
short-lived Epode feedback contract. Existing workspace and run IDs provide
optional customer and session grouping.
