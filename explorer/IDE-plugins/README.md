# Explorer document plugins

Explorer includes `scripta-variants` for collaborative paragraph variants, voting and editing through the existing shared SCRIPTA view and document model. It does not require installing or enabling `soplangAgent`.

Image, audio and video attachment plugins belong only to `multimedia/IDE-plugins` in the optional `AssistOS-AI/legacy-agents` repository. Explorer does not bundle those plugins or their upload helpers. Installing that repository explicitly makes its document plugins available through the normal plugin discovery and policy controls. Existing document media metadata and Explorer blob services remain unchanged.

The SCRIPTA Variants UI source originated in `soplangAgent/IDE-plugins/scripta-variants` at `AssistOS-AI/legacy-agents` revision `a495a5e22db6fd711b34f5cb58206b49829e9bb9`. Explorer keeps precedence over an installed copy of the same document component.
