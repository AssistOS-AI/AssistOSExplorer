import {
    isMediaDiagnosticsEnabled,
    logMediaDiagnostic,
    summarizeAudioSettings,
    summarizeAudioWebRtcStats,
    summarizeIceTransport,
    summarizeParticipant,
    summarizePublication,
    summarizeTrack,
    summarizeVideoElement
} from '../services/media-diagnostics.js';
import { isAudioPublication } from '../services/microphone-publication.js';

export const roomSessionMethods = {
    installJoinMaterialRefreshListeners() {
        if (this.joinMaterialNetworkRefreshHandler) return;
        this.joinMaterialNetworkRefreshHandler = () => {
            if (!this.roomLiveKit?.getRoom?.() || navigator.onLine === false) return;
            void this.refreshJoinMaterialAndReconnect('network-transition');
        };
        window.addEventListener('online', this.joinMaterialNetworkRefreshHandler);
        navigator.connection?.addEventListener?.('change', this.joinMaterialNetworkRefreshHandler);
    },

    uninstallJoinMaterialRefreshListeners() {
        window.clearTimeout(this.joinMaterialRefreshTimer);
        this.joinMaterialRefreshTimer = null;
        if (!this.joinMaterialNetworkRefreshHandler) return;
        window.removeEventListener('online', this.joinMaterialNetworkRefreshHandler);
        navigator.connection?.removeEventListener?.('change', this.joinMaterialNetworkRefreshHandler);
        this.joinMaterialNetworkRefreshHandler = null;
    },

    scheduleJoinMaterialRefresh() {
        window.clearTimeout(this.joinMaterialRefreshTimer);
        this.joinMaterialRefreshTimer = null;
        const iceServers = Array.isArray(this.state.session?.rtcConfig?.iceServers)
            ? this.state.session.rtcConfig.iceServers
            : [];
        if (iceServers.length === 0) return;
        const expiresAtMs = Date.parse(String(this.state.session?.turnExpiresAt || ''));
        if (!Number.isFinite(expiresAtMs)) {
            throw new Error('Join material is missing a valid TURN expiry.');
        }
        const remainingMs = expiresAtMs - Date.now();
        if (remainingMs <= 30_000) {
            throw new Error('Join material expires too soon to establish a supported media session.');
        }
        const refreshLeadMs = Math.min(60_000, Math.max(10_000, Math.floor(remainingMs * 0.2)));
        this.joinMaterialRefreshTimer = window.setTimeout(() => {
            void this.refreshJoinMaterialAndReconnect('credential-expiry');
        }, remainingMs - refreshLeadMs);
    },

    async refreshJoinMaterialAndReconnect(reason = 'credential-refresh') {
        if (this.joinMaterialRefreshInFlight || !this.state.session?.participantIdentity) return;
        this.joinMaterialRefreshInFlight = true;
        const mediaToRestore = { ...this.state.media };
        try {
            await this.webMeetRoom.refreshJoinMaterial();
            await this.disconnectRoom({ stopMediaFirst: false });
            await this.connectRoom();
            if (mediaToRestore.microphone && !this.state.media.microphone) await this.toggleMicrophone();
            if (mediaToRestore.camera && !this.state.media.camera) await this.toggleCamera();
            if (mediaToRestore.screen) {
                this.state.roomState = 'Connected. Screen sharing stopped during media credential refresh; use Share screen to resume.';
                this.setError(this.state.roomState);
                this.renderMeetingSummary();
            }
            logMediaDiagnostic('join-material-recreated', { reason });
        } catch (error) {
            window.clearTimeout(this.joinMaterialRefreshTimer);
            this.joinMaterialRefreshTimer = null;
            await this.disconnectRoom().catch(() => {});
            const message = error instanceof Error ? error.message : String(error);
            this.state.roomState = `Media credentials could not be refreshed: ${message}`;
            this.setError(this.state.roomState);
            this.renderMeetingSummary();
        } finally {
            this.joinMaterialRefreshInFlight = false;
        }
    },

    async connectRoom() {
        if (!this.state.session?.participantToken || !this.state.session?.livekitUrl) {
            this.state.roomState = 'Join payload missing media token';
            this.renderMeetingSummary();
            return;
        }
        await this.disconnectRoom();
        await this.chatComponent?.prepareRoboMicrophonePermission?.();
        this.state.activeSpeakerIds = new Set();

        const remoteVideoRecoveryCounts = new WeakMap();

        const isRemoteVideoElementReady = (mediaElement) => {
            if (!mediaElement) return false;
            return Number(mediaElement.videoWidth || 0) > 0
                || Number(mediaElement.videoHeight || 0) > 0
                || Number(mediaElement.currentTime || 0) > 0
                || Number(mediaElement.readyState || 0) >= HTMLMediaElement.HAVE_CURRENT_DATA;
        };

        let refreshRemoteVideoSubscription = () => {};

        const scheduleRemoteVideoReadinessDiagnostics = (participant, publication, mediaElement, TrackRef = null, reason = 'remote-video') => {
            const Track = TrackRef || window.LivekitClient?.Track || null;
            const isVideoTrack = Track
                ? publication?.kind === Track.Kind.Video
                : publication?.track?.kind === 'video';
            if (!publication || !mediaElement || !isVideoTrack) return;

            for (const delay of [1500, 3500, 7000]) {
                window.setTimeout(() => {
                    if (!this.room) return;
                    if (!mediaElement.isConnected) return;
                    const isReady = isRemoteVideoElementReady(mediaElement);
                    logMediaDiagnostic('remote-video-readiness-check', {
                        reason,
                        delay,
                        isReady,
                        participant: summarizeParticipant(participant),
                        publication: summarizePublication(publication),
                        videoElement: summarizeVideoElement(mediaElement)
                    });
                    if (!isReady && delay >= 3500) {
                        refreshRemoteVideoSubscription(publication, participant, `${reason}:not-ready:${delay}`);
                    }
                }, delay);
            }
        };

        const renderPublication = (participant, publication, explicitTrack = null, TrackRef = null) => {
            const Track = TrackRef || window.LivekitClient?.Track;
            if (!Track) return;
            const participantId = String(participant?.identity || '').trim();
            if (!participantId || !publication) return;
            this.upsertParticipantView({
                identity: participantId,
                name: this.getParticipantDisplayName(participant),
                kind: participantId === this.room?.localParticipant?.identity ? 'local' : 'remote'
            });
            const track = explicitTrack || publication.track;
            if (!track) return;
            const trackId = String(
                publication.trackSid
                || `${participantId}:${publication.source || publication.kind || track.kind || 'track'}`
            ).trim();
            if (!trackId) return;
            const isLocalParticipant = participantId === this.room?.localParticipant?.identity;

            if (track.kind === Track.Kind.Video) {
                const existingTrackEntry = this.participantLayoutController.getTrackEntry(trackId);
                if (existingTrackEntry?.element) {
                    logMediaDiagnostic('video-track-attach-skip-existing', {
                        participant: summarizeParticipant(participant),
                        publication: summarizePublication(publication),
                        track: summarizeTrack(track),
                        trackId,
                        videoElement: summarizeVideoElement(existingTrackEntry.element)
                    });
                    return;
                }
                const mediaElement = track.attach();
                mediaElement.autoplay = true;
                mediaElement.playsInline = true;
                mediaElement.dataset.trackSource = String(publication.source || '').trim();
                if (participantId === this.room?.localParticipant?.identity) {
                    mediaElement.muted = true;
                }
                logMediaDiagnostic('video-track-attached', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication),
                    track: summarizeTrack(track),
                    trackId,
                    isLocalParticipant
                });
                this.attachVideoTrack(participantId, trackId, mediaElement);
                if (!isLocalParticipant) {
                    for (const eventName of ['loadedmetadata', 'playing', 'waiting', 'stalled', 'error']) {
                        mediaElement.addEventListener(eventName, () => {
                            logMediaDiagnostic('remote-video-element-event', {
                                eventName,
                                participant: summarizeParticipant(participant),
                                publication: summarizePublication(publication),
                                videoElement: summarizeVideoElement(mediaElement)
                            });
                        }, { once: eventName !== 'waiting' });
                    }
                    scheduleRemoteVideoReadinessDiagnostics(participant, publication, mediaElement, Track, 'render-video');
                }
            } else if (track.kind === Track.Kind.Audio) {
                if (!isLocalParticipant) {
                    const mediaElement = track.attach();
                    mediaElement.autoplay = true;
                    mediaElement.dataset.trackSource = String(publication.source || '').trim();
                    void this.applyAudioOutputDeviceToElement(mediaElement);
                    this.attachAudioTrack(participantId, trackId, mediaElement);
                    this.applyOutputVolumePreviewToElement(mediaElement);
                    void this.ensureRemoteAudioPlayback?.(mediaElement);
                }
                if (this.isMicrophonePublication(publication, Track, participant)) {
                    this.setParticipantMicState(participantId, !publication.isMuted);
                }
            }
        };

        const removePublication = (publication, TrackRef = null, participant = null) => {
            const Track = TrackRef || window.LivekitClient?.Track;
            const participantId = String(participant?.identity || '').trim();
            const source = String(publication?.source || '').trim();
            const rawKind = String(publication?.kind || publication?.track?.kind || publication?.track?.mediaStreamTrack?.kind || '').trim();
            const isVideoSource = Track && [
                Track.Source?.Camera,
                Track.Source?.ScreenShare
            ].map((value) => String(value || '').trim()).filter(Boolean).includes(source);
            const isAudioSource = Track && [
                Track.Source?.Microphone,
                Track.Source?.ScreenShareAudio
            ].map((value) => String(value || '').trim()).filter(Boolean).includes(source);
            const publicationKind = Track && publication?.kind === Track.Kind.Video ? 'video'
                : Track && publication?.kind === Track.Kind.Audio ? 'audio'
                    : rawKind === 'video' || isVideoSource ? 'video'
                        : rawKind === 'audio' || isAudioSource ? 'audio'
                            : '';
            const candidateTrackIds = [
                publication?.trackSid,
                publication?.track?.sid,
                participantId && source ? `${participantId}:${source}` : '',
                participantId && source && publicationKind ? `${participantId}:${source}:${publicationKind}` : '',
                participantId && publicationKind ? `${participantId}:${publicationKind}` : ''
            ].map((value) => String(value || '').trim()).filter(Boolean);
            const trackIds = new Set(candidateTrackIds.filter((trackId) => (
                this.participantLayoutController.getTrackEntry(trackId)
            )));

            if (!trackIds.size && participantId) {
                for (const trackId of this.participantLayoutController.findTrackIdsForParticipant(participantId, {
                    kind: publicationKind,
                    source
                })) {
                    trackIds.add(trackId);
                }
            }
            if (!trackIds.size && participantId && publicationKind === 'video' && !source) {
                for (const trackId of this.participantLayoutController.findTrackIdsForParticipant(participantId, {
                    kind: 'video'
                })) {
                    trackIds.add(trackId);
                }
            }
            if (!trackIds.size) return;

            let trackInfo = null;
            for (const trackId of trackIds) {
                trackInfo = trackInfo || this.participantLayoutController.getTrackEntry(trackId);
                this.removeTrack(trackId);
            }
            if (Track && isAudioPublication(publication, Track)) {
                const participantId = String(trackInfo?.participantId || '').trim();
                if (participantId) {
                    const participant = participantId === this.room?.localParticipant?.identity
                        ? this.room.localParticipant
                        : this.room?.remoteParticipants?.get?.(participantId);
                    this.setParticipantMicState(participantId, this.isParticipantMicOn(participant, Track));
                }
            }
        };

        const setPublicationSubscribed = (publication, shouldSubscribe, participant, reason) => {
            if (!publication || typeof publication.setSubscribed !== 'function') return;
            logMediaDiagnostic('publication-set-subscribed', {
                shouldSubscribe,
                reason,
                participant: summarizeParticipant(participant),
                publication: summarizePublication(publication)
            });
            try {
                const result = publication.setSubscribed(shouldSubscribe);
                if (result && typeof result.catch === 'function') {
                    result.catch((error) => {
                        logMediaDiagnostic('publication-set-subscribed-rejected', {
                            shouldSubscribe,
                            reason,
                            message: error instanceof Error ? error.message : String(error)
                        });
                    });
                }
            } catch (error) {
                logMediaDiagnostic('publication-set-subscribed-error', {
                    shouldSubscribe,
                    reason,
                    message: error instanceof Error ? error.message : String(error)
                });
                // LiveKit may reject subscription changes during disconnect/reconnect.
            }
        };

        refreshRemoteVideoSubscription = (publication, participant, reason) => {
            if (!publication || typeof publication.setSubscribed !== 'function') return;
            if (publication.isMuted) return;
            const track = publication.track || null;
            const mediaStreamTrack = track?.mediaStreamTrack || null;
            if (mediaStreamTrack && mediaStreamTrack.readyState !== 'live') return;
            const refreshCount = remoteVideoRecoveryCounts.get(publication) || 0;
            if (refreshCount >= 2) return;
            remoteVideoRecoveryCounts.set(publication, refreshCount + 1);
            const Track = window.LivekitClient?.Track || null;
            logMediaDiagnostic('remote-video-subscription-refresh', {
                reason,
                attempt: refreshCount + 1,
                participant: summarizeParticipant(participant),
                publication: summarizePublication(publication),
                track: summarizeTrack(track)
            });
            removePublication(publication, Track, participant);
            setPublicationSubscribed(publication, false, participant, `${reason}:refresh-off`);
            window.setTimeout(() => {
                if (!this.room) return;
                setPublicationSubscribed(publication, true, participant, `${reason}:refresh-on`);
                window.setTimeout(() => {
                    if (!this.room || !publication.track) return;
                    renderPublication(participant, publication, publication.track, Track);
                }, 900);
            }, 250);
        };

        const subscribePublication = (publication, participant = null, TrackRef = null, reason = 'subscribe') => {
            const participantId = String(participant?.identity || '').trim();
            const localParticipantId = String(this.room?.localParticipant?.identity || '').trim();
            if (!publication || !participantId || participantId === localParticipantId) return;
            logMediaDiagnostic('publication-subscribe-check', {
                reason,
                participant: summarizeParticipant(participant),
                publication: summarizePublication(publication)
            });
            if (publication.track) {
                renderPublication(participant, publication, publication.track, TrackRef);
            }

            if (publication.isSubscribed && publication.track) {
                const Track = TrackRef || window.LivekitClient?.Track || null;
                const isVideoTrack = Track
                    ? publication.kind === Track.Kind.Video
                    : publication.track.kind === 'video';
                const mediaStreamTrack = publication.track.mediaStreamTrack || null;
                const isStuckRemoteVideo = isVideoTrack
                    && !publication.isMuted
                    && mediaStreamTrack?.readyState === 'live'
                    && mediaStreamTrack.muted === true;
                if (isStuckRemoteVideo) {
                    refreshRemoteVideoSubscription(publication, participant, `${reason}:muted-track`);
                }
                return;
            }

            if (publication.isSubscribed && !publication.track) {
                window.setTimeout(() => {
                    if (publication.track) {
                        setPublicationSubscribed(publication, true, participant, `${reason}:ensure-on`);
                        return;
                    }
                    refreshRemoteVideoSubscription(publication, participant, `${reason}:missing-track`);
                }, 500);
                return;
            }

            setPublicationSubscribed(publication, true, participant, reason);
        };

        const subscribeParticipantPublications = (participant, TrackRef = null, reason = 'participant-sweep') => {
            if (!participant?.trackPublications?.values) return;
            for (const publication of participant.trackPublications.values()) {
                subscribePublication(publication, participant, TrackRef, reason);
            }
        };

        const subscribeRemotePublications = (TrackRef = null, reason = 'room-sweep') => {
            if (!this.room?.remoteParticipants?.values) return;
            for (const participant of this.room.remoteParticipants.values()) {
                subscribeParticipantPublications(participant, TrackRef, reason);
            }
        };

        const scheduleRemoteSubscriptionSweep = (TrackRef = null, reason = 'scheduled-sweep') => {
            for (const delay of [250, 1000, 2500, 5000]) {
                window.setTimeout(() => subscribeRemotePublications(TrackRef, `${reason}:${delay}`), delay);
            }
        };

        const collectAudioWebRtcDiagnostics = async () => {
            if (!isMediaDiagnosticsEnabled() || !this.room) return;
            const publications = [
                ...(this.room.localParticipant?.trackPublications?.values?.() || []),
                ...[...(this.room.remoteParticipants?.values?.() || [])]
                    .flatMap((participant) => [...(participant.trackPublications?.values?.() || [])])
            ];
            const reports = [];
            for (const publication of publications) {
                const track = publication?.track || null;
                if (typeof track?.getRTCStatsReport !== 'function') continue;
                try {
                    const report = await track.getRTCStatsReport();
                    reports.push(...(report?.values?.() || report || []));
                } catch (_) {
                    // A track may disappear while diagnostics are being collected.
                }
            }
            logMediaDiagnostic('audio-webrtc-stats', {
                ...summarizeAudioWebRtcStats(reports),
                transport: summarizeIceTransport(reports)
            });
        };

        await this.roomLiveKit.connect(this.state.session, {
            onRoomCreated: ({ room }) => {
                this.room = room;
            },
            onConnecting: () => {
                this.state.roomState = 'Connecting';
                this.renderMeetingSummary();
            },
            onTrackSubscribed: (track, publication, participant, { Track }) => {
                logMediaDiagnostic('room-track-subscribed', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication),
                    track: summarizeTrack(track)
                });
                renderPublication(participant, publication, track, Track);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onTrackUnsubscribed: (_track, publication, participant, { Track }) => {
                logMediaDiagnostic('room-track-unsubscribed', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication),
                    track: summarizeTrack(_track)
                });
                removePublication(publication, Track, participant);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onLocalTrackPublished: (publication, { room, Track }) => {
                logMediaDiagnostic('room-local-track-published', {
                    publication: summarizePublication(publication)
                });
                renderPublication(room.localParticipant, publication, null, Track);
                if (publication?.source === Track?.Source?.Camera) {
                    void this.mediaController.syncBackgroundEffect().catch((error) => {
                        this.setError(error instanceof Error ? error.message : 'Background effect could not be applied.');
                    });
                }
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
                if (this.isMicrophonePublication(publication, Track, room.localParticipant)) {
                    this.voiceResponsiveAvatarController?.setLiveKitState?.({
                        microphoneAvailable: true,
                        microphoneTrack: publication?.track?.mediaStreamTrack
                            || publication?.track?.mediaStream?.getAudioTracks?.()[0]
                            || publication?.track
                            || null
                    });
                }
                this.syncVoiceResponsiveAvatar?.(Track, { refreshMicrophone: false });
                scheduleRemoteSubscriptionSweep(Track, 'local-published');
            },
            onLocalTrackUnpublished: (publication, { Track }) => {
                logMediaDiagnostic('room-local-track-unpublished', {
                    publication: summarizePublication(publication)
                });
                removePublication(publication, Track, this.room?.localParticipant || null);
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
                if (this.isMicrophonePublication(publication, Track, this.room?.localParticipant || null)) {
                    this.voiceResponsiveAvatarController?.setLiveKitState?.({
                        microphoneAvailable: false,
                        localSpeaking: false
                    });
                }
                this.syncVoiceResponsiveAvatar?.(Track, { refreshMicrophone: false });
                scheduleRemoteSubscriptionSweep(Track, 'local-unpublished');
            },
            onRemoteTrackPublished: (publication, participant, { Track }) => {
                logMediaDiagnostic('room-remote-track-published', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication)
                });
                subscribePublication(publication, participant, Track, 'remote-track-published');
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'remote-track-published');
            },
            onParticipantConnected: (participant, { Track }) => {
                this.meetingNotesTranscription?.sync?.();
                this.playParticipantJoinSound(participant);
                subscribeParticipantPublications(participant, Track, 'participant-connected');
                this.syncParticipantsFromRoom(this.room, Track);
                void this.webMeetRoom.republishAvatarProjection().catch(() => {});
                void this.webMeetRoom.requestAvatarState().catch(() => {});
                scheduleRemoteSubscriptionSweep(Track, 'participant-connected');
            },
            onParticipantDisconnected: (participant, { Track }) => {
                this.meetingNotesTranscription?.sync?.();
                this.playParticipantLeaveSound(participant);
                const participantId = String(participant?.identity || '').trim();
                this.clearRoomAvatar?.(participantId);
                if (participantId && this.state.activeSpeakerIds instanceof Set) {
                    this.state.activeSpeakerIds.delete(participantId);
                }
                for (const publication of participant.trackPublications.values()) {
                    removePublication(publication, Track, participant);
                }
                this.removeParticipantView(participant.identity);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onActiveSpeakersChanged: (participants, { Track }) => {
                this.setActiveSpeakers(participants, Track);
            },
            onTrackMuted: (publication, participant, { Track }) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                const isMicrophoneTrack = this.isMicrophonePublication(publication, Track, participant);
                if (isVideoTrack) {
                    removePublication(publication, Track, participant);
                } else if (isMicrophoneTrack) {
                    this.setParticipantMicState(participantId, false);
                }
                if (
                    isMicrophoneTrack
                    && participantId === String(this.room?.localParticipant?.identity || '').trim()
                ) {
                    this.voiceResponsiveAvatarController?.setLiveKitState?.({
                        microphoneAvailable: false,
                        localSpeaking: false
                    });
                    this.syncLocalMediaStateFromRoom(Track);
                    this.renderMeetingSummary();
                    this.syncVoiceResponsiveAvatar?.(Track, { refreshMicrophone: false });
                }
            },
            onTrackUnmuted: (publication, participant, { Track }) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                const isMicrophoneTrack = this.isMicrophonePublication(publication, Track, participant);
                if (isVideoTrack) {
                    renderPublication(participant, publication, publication?.track || null, Track);
                }
                if (isMicrophoneTrack) {
                    const sourceParticipant = participantId === this.room?.localParticipant?.identity
                        ? this.room.localParticipant
                        : this.room?.remoteParticipants?.get?.(participantId) || participant;
                    this.setParticipantMicState(participantId, this.isParticipantMicOn(sourceParticipant, Track));
                }
                if (
                    isMicrophoneTrack
                    && participantId === String(this.room?.localParticipant?.identity || '').trim()
                ) {
                    this.voiceResponsiveAvatarController?.setLiveKitState?.({
                        microphoneAvailable: true,
                        microphoneTrack: publication?.track?.mediaStreamTrack
                            || publication?.track?.mediaStream?.getAudioTracks?.()[0]
                            || publication?.track
                            || null
                    });
                    this.syncLocalMediaStateFromRoom(Track);
                    this.renderMeetingSummary();
                    this.syncVoiceResponsiveAvatar?.(Track, { refreshMicrophone: false });
                }
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onDataReceived: (payload, participant) => {
                try {
                    const text = new TextDecoder().decode(payload);
                    this.emitWebMeetInternalEvent('livekit', text, {
                        participantId: String(participant?.identity || '').trim()
                    });
                } catch (err) {
                    // Ignore malformed data-channel messages from other clients.
                }
            },
            onParticipantAttributesChanged: (changedAttributes, participant, { Track }) => {
                this.meetingNotesTranscription?.sync?.();
                const rawAvatar = String(changedAttributes?.webmeetProfileAvatar || '').trim();
                if (rawAvatar) {
                    try {
                        const profileAvatar = JSON.parse(rawAvatar);
                        if (profileAvatar && typeof profileAvatar === 'object' && !Array.isArray(profileAvatar)) {
                            const participantId = String(participant?.identity || '').trim();
                            const userId = String(
                                participant?.attributes?.ploinkyUserId
                                || participant?.attributes?.workspaceUserId
                                || participant?.attributes?.userId
                                || participant?.attributes?.webmeetUserId
                                || ''
                            ).trim();
                            this.applyRealtimeParticipantAvatar?.({
                                meetingId: String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim(),
                                participantId,
                                userId,
                                preserveRuntimeState: true,
                                profileAvatar
                            });
                        }
                    } catch (_) {
                        // Ignore malformed avatar attributes and let the normal room sync continue.
                    }
                }
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onConnectionQualityChanged: (quality, participant) => {
                const qualityLabel = String(quality || '').trim().toLowerCase();
                const participantId = String(participant?.identity || '').trim();
                const localParticipantId = String(this.room?.localParticipant?.identity || '').trim();
                const isLocalParticipant = !participantId || participantId === localParticipantId;
                logMediaDiagnostic('connection-quality-changed', {
                    quality: qualityLabel,
                    participant: summarizeParticipant(participant)
                });
                if (!isLocalParticipant) return;
                this.state.audioNetworkUnstable = qualityLabel.includes('poor') || qualityLabel.includes('lost');
                this.state.audioHealth = this.state.audioNetworkUnstable ? 'Network unstable' : 'Good';
                this.updateAudioHealthIndicator?.();
            },
            onDisconnected: () => {
                if (this.expectedLiveKitDisconnect) {
                    this.resetRoomUiState({ forceRenderAll: true, applyVideoFullscreenMode: false });
                    return;
                }
                this.webMeetRoom.handleExternalLiveKitDisconnect();
                void this.handleExternalRoomDisconnect();
            },
            onConnected: ({ room, Track }) => {
                this.state.roomState = 'Connected';
                this.installJoinMaterialRefreshListeners();
                this.scheduleJoinMaterialRefresh();
                this.meetingNotesTranscription?.sync?.();
                this.syncParticipantsFromRoom(this.room, Track);
                this.syncVoiceResponsiveAvatar?.(Track);
                this.logAudioCaptureDiagnostics();
                const skipConnectedAvatarRepublishOnce = Boolean(this.state.skipConnectedAvatarRepublishOnce);
                this.state.skipConnectedAvatarRepublishOnce = false;
                void (async () => {
                    if (!skipConnectedAvatarRepublishOnce) {
                        await this.webMeetRoom.republishAvatarProjection();
                    }
                    await this.webMeetRoom.requestAvatarState();
                })().catch(() => {});
                for (const participant of room.remoteParticipants.values()) {
                    subscribeParticipantPublications(participant, Track, 'connected');
                }
                scheduleRemoteSubscriptionSweep(Track, 'connected');
                window.clearInterval(this.audioWebRtcStatsTimer);
                this.audioWebRtcStatsTimer = isMediaDiagnosticsEnabled()
                    ? window.setInterval(() => void collectAudioWebRtcDiagnostics(), 10000)
                    : null;
                void collectAudioWebRtcDiagnostics();
                this.renderMeetingSummary();
            },
            onConnectError: (error) => {
                this.state.roomState = error instanceof Error ? error.message : String(error);
                this.renderMeetingSummary();
            }
        });
    },

    logAudioCaptureDiagnostics() {
        const settings = this.mediaController?.getSettings?.() || this.state.mediaSettings || {};
        logMediaDiagnostic('audio-settings', summarizeAudioSettings({
            ...settings,
            profile: this.mediaController?.getMicrophoneProfile?.()
        }));
        const appliedTrack = this.mediaController?.getActiveMicrophoneMediaStreamTrack?.() || null;
        if (appliedTrack && typeof this.mediaController?.summarizeAppliedMicrophoneSettings === 'function') {
            logMediaDiagnostic('audio-capture-applied', this.mediaController.summarizeAppliedMicrophoneSettings(appliedTrack));
        }
    },

    async handleExternalRoomDisconnect() {
        this.resetRoomUiState({ forceRenderAll: false, applyVideoFullscreenMode: false });
        if (!this.isGuestSession()) {
            await this.loadMeetings();
            this.startWorkspaceEvents();
        }
        this.renderAll();
    },

    resetRoomUiState(options = {}) {
        const forceRenderAll = Boolean(options.forceRenderAll);
        const applyVideoFullscreenMode = Boolean(options.applyVideoFullscreenMode);
        const clearSession = Boolean(options.clearSession);
        this.room = this.roomLiveKit.getRoom();
        this.mediaController.reset();
        this.state.roomState = 'Disconnected';
        this.state.media = { microphone: false, camera: false, screen: false };
        this.state.mediaDeafened = false;
        this.state.mediaDeafenRestoreMicrophone = false;
        this.state.mediaLoading = { microphone: false, camera: false, screen: false };
        this.state.participants = [];
        this.state.roomAvatarsByParticipantId = {};
        this.state.avatarProjectionSequencesByParticipantId = {};
        this.state.skipConnectedAvatarRepublishOnce = false;
        this.state.activeSpeakerIds = new Set();
        this.voiceResponsiveAvatarController?.resetLiveKitState?.({ clearRuntimeState: false });
        this.state.videoGridFullscreen = false;
        this.resetBlackboardUiState?.();
        this.state.audioHealth = 'Good';
        this.state.audioNetworkUnstable = false;
        this.state.meetingNotesActivity = null;
        if (clearSession) {
            this.state.session = null;
        }
        this.meetingNotesTranscription?.sync?.();
        window.clearInterval(this.audioWebRtcStatsTimer);
        this.audioWebRtcStatsTimer = null;
        this.remoteAudioNormalizer?.stopAll?.();
        this.participantLayoutController.clearAll('Join a meeting to attach media tracks.');
        if (applyVideoFullscreenMode) {
            this.applyVideoGridFullscreenMode();
        }
        if (forceRenderAll) {
            this.renderAll();
        } else {
            this.renderMeetingSummary();
            this.renderFeedLists();
        }
    },

    muteRoomPlaybackElements() {
        const mediaElements = [
            ...this.participantLayoutController.getTrackEntries()
                .filter((entry) => entry?.kind === 'audio' || entry?.kind === 'video')
                .map((entry) => entry.element)
                .filter(Boolean),
            ...Array.from(this.element?.querySelectorAll?.('audio, video') || [])
        ];
        for (const mediaElement of new Set(mediaElements)) {
            try { mediaElement.muted = true; } catch (_) {}
            try { mediaElement.volume = 0; } catch (_) {}
            try { mediaElement.pause?.(); } catch (_) {}
        }
    },

    cleanupLocalLiveKitMediaForWindowExit() {
        const room = this.roomLiveKit?.getRoom?.() || this.room;
        try {
            this.mediaController?.reset?.();
        } catch (_) {
            // Window teardown must continue even if controller cleanup fails.
        }
        try {
            const publications = room?.localParticipant?.trackPublications?.values
                ? Array.from(room.localParticipant.trackPublications.values())
                : [];
            for (const publication of publications) {
                try { publication?.track?.stop?.(); } catch (_) {}
                try { publication?.track?.mediaStreamTrack?.stop?.(); } catch (_) {}
                try { room.localParticipant?.unpublishTrack?.(publication.track); } catch (_) {}
            }
        } catch (_) {
            // LiveKit will also tear down on page close; this is best effort.
        }
        try {
            this.muteRoomPlaybackElements();
        } catch (_) {
            // Ignore media element cleanup failures during page close.
        }
    },

    unsubscribeRemotePublications(room = this.roomLiveKit.getRoom()) {
        for (const participant of room?.remoteParticipants?.values?.() || []) {
            for (const publication of participant?.trackPublications?.values?.() || []) {
                try {
                    const result = publication?.setSubscribed?.(false);
                    if (result && typeof result.catch === 'function') {
                        result.catch(() => {});
                    }
                } catch (_) {
                    // Ignore subscription changes rejected during disconnect.
                }
            }
        }
    },

    async stopRoomMediaBeforeDisconnect(room = this.roomLiveKit.getRoom()) {
        this.muteRoomPlaybackElements();
        this.unsubscribeRemotePublications(room);
        await this.mediaController.stopAllLocalMedia(room);
        this.state.mediaDeafened = true;
        this.state.mediaDeafenRestoreMicrophone = false;
        this.state.media = { microphone: false, camera: false, screen: false };
        this.state.mediaLoading = { microphone: false, camera: false, screen: false };
        this.renderMeetingSummary();
    },

    async disconnectRoom(options = {}) {
        window.clearTimeout(this.joinMaterialRefreshTimer);
        this.joinMaterialRefreshTimer = null;
        const room = this.roomLiveKit.getRoom();
        if (!room) return;
        if (options.stopMediaFirst !== false) {
            await this.stopRoomMediaBeforeDisconnect(room);
        }
        this.expectedLiveKitDisconnect = true;
        try {
            await this.roomLiveKit.disconnect();
        } finally {
            this.expectedLiveKitDisconnect = false;
        }
        this.resetRoomUiState({ forceRenderAll: true, applyVideoFullscreenMode: true });
    },

    async toggleMicrophone() {
        if (this.state.mediaDeafened && !this.state.media.microphone) {
            this.state.mediaDeafened = false;
            this.state.mediaDeafenRestoreMicrophone = false;
            this.applyOutputVolumePreviewToAllAudioElements();
        }
        await this.runMediaToggleWithLoading('microphone', () => this.mediaController.toggleMicrophone());
    },

    async toggleDeafen() {
        if (!this.state.session?.participantIdentity) return;
        if (Object.values(this.state.mediaLoading || {}).some(Boolean)) return;
        const shouldDeafen = !this.state.mediaDeafened;
        const shouldRestoreMicrophone = !shouldDeafen
            && Boolean(this.state.mediaDeafenRestoreMicrophone)
            && !this.state.media.microphone;
        if (shouldDeafen) {
            this.state.mediaDeafenRestoreMicrophone = Boolean(this.state.media.microphone);
        }
        this.state.mediaDeafened = shouldDeafen;
        this.applyOutputVolumePreviewToAllAudioElements();
        if (shouldDeafen && this.state.media.microphone) {
            await this.toggleMicrophone();
        } else if (shouldRestoreMicrophone) {
            try {
                await this.toggleMicrophone();
            } finally {
                this.state.mediaDeafenRestoreMicrophone = false;
            }
        } else {
            if (!shouldDeafen) {
                this.state.mediaDeafenRestoreMicrophone = false;
            }
            this.renderMeetingSummary();
        }
    },

    async toggleCamera() {
        await this.runMediaToggleWithLoading('camera', () => this.mediaController.toggleCamera());
    },

    async toggleScreenShare() {
        await this.runMediaToggleWithLoading('screen', () => this.mediaController.toggleScreenShare());
    },

    async waitForLocalVideoCardVisible(timeoutMs = 2500) {
        const start = Date.now();
        const localParticipantId = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        if (!localParticipantId) return false;

        while ((Date.now() - start) < timeoutMs) {
            const view = this.participantLayoutController.getParticipantView(localParticipantId);
            const videoElement = view?.videoElement || null;
            const videoReady = !videoElement
                || Number(videoElement.readyState || 0) >= 1
                || Boolean(videoElement.srcObject);
            if (view?.hasVideo && videoElement?.isConnected && videoReady) {
                return true;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return false;
    },

    setLocalVideoCardLoading(isLoading) {
        const localParticipantId = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        if (!localParticipantId) return;
        this.participantLayoutController.setParticipantVideoLoading(localParticipantId, isLoading);
    },

    async runMediaToggleWithLoading(type, action) {
        if (Object.values(this.state.mediaLoading || {}).some(Boolean)) {
            return;
        }
        const shouldWaitForLocalVideo = (type === 'camera' || type === 'screen')
            && !this.mediaController.isLocalSourceEnabled(type);
        this.setMediaLoading(type, true);
        if (shouldWaitForLocalVideo) {
            this.setLocalVideoCardLoading(true);
        }
        let localVideoVisible = false;
        try {
            await action();
            if (shouldWaitForLocalVideo && this.mediaController.isLocalSourceEnabled(type)) {
                localVideoVisible = await this.waitForLocalVideoCardVisible();
            }
        } finally {
            const sourceStillEnabled = shouldWaitForLocalVideo && this.mediaController.isLocalSourceEnabled(type);
            if (shouldWaitForLocalVideo && (!sourceStillEnabled || localVideoVisible)) {
                this.setLocalVideoCardLoading(false);
            }
            this.setMediaLoading(type, false);
        }
    }

};
