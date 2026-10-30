# Explorer document plugins

Explorer owns `scripta-variants`, `image-plugin`, `audio-plugin` and `video-plugin`. They ship with the Markdown Advanced Editor and do not require installing or enabling `soplangAgent` or `multimedia`. Variants use the existing shared SCRIPTA view and document model. Media attachments use Explorer's existing authenticated blob endpoint and document mutations. Metadata keys and presenter component names are retained, so existing Markdown documents remain readable.

The UI sources were moved from `AssistOS-AI/legacy-agents` revision `a495a5e22db6fd711b34f5cb58206b49829e9bb9`: `soplangAgent/IDE-plugins/scripta-variants` and the three attachment plugins plus their shared helpers under `multimedia/IDE-plugins`. Icons now resolve relative to each owning plugin. `document-media/` contains the shared upload, URL and document-context helpers; it is not an independent plugin.

When another installed agent includes an older document component with the same name, the Explorer-owned component takes precedence in discovery. Agent application plugins and distinct document components are unchanged. This move does not enable media-generation, FFmpeg, SOPLang or task-processing backends.
