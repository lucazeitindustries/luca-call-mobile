import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  StatusBar,
  Animated,
  SafeAreaView,
  ActivityIndicator,
  Platform,
} from "react-native";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { WebView } from "react-native-webview";

const API_BASE = "https://luca-call.vercel.app/api";
const WS_URL = "wss://luca-call-ws.onrender.com";

const CANVAS_DEFAULT_HTML = `
<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0a0a; color:#fff; font-family:-apple-system,system-ui,sans-serif;
    display:flex; align-items:center; justify-content:center; height:100vh; padding:24px; }
  .container { text-align:center; opacity:0.4; }
  h1 { font-size:28px; font-weight:200; letter-spacing:2px; margin-bottom:8px; }
  p { font-size:14px; font-weight:300; color:#666; }
</style></head>
<body><div class="container"><h1>LUCA</h1><p>Hold the mic to speak</p></div></body>
</html>`;

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [canvasHtml, setCanvasHtml] = useState(CANVAS_DEFAULT_HTML);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const wsRef = useRef<WebSocket | null>(null);

  // WebSocket for canvas updates
  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "canvas" && data.html) {
            setCanvasHtml(wrapHtml(data.html));
          }
        } catch {}
      };
      ws.onclose = () => setTimeout(connect, 3000);
      ws.onerror = () => ws.close();
    }
    connect();
    return () => wsRef.current?.close();
  }, []);

  function wrapHtml(content: string) {
    if (content.trim().startsWith("<!DOCTYPE") || content.trim().startsWith("<html")) return content;
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:-apple-system,system-ui,sans-serif;padding:20px}
h1,h2,h3{font-weight:300;margin-bottom:12px}p{line-height:1.6;color:#ccc}a{color:#4ecdc4}
img{max-width:100%;border-radius:8px}pre{background:#1a1a1a;padding:16px;border-radius:8px;overflow-x:auto;color:#ccc}
code{font-family:monospace;background:#1a1a1a;padding:2px 6px;border-radius:4px}</style></head>
<body>${content}</body></html>`;
  }

  // Pulse animation while recording
  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      ).start();
      Animated.timing(glowAnim, { toValue: 1, duration: 300, useNativeDriver: false }).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
      Animated.timing(glowAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start();
    }
  }, [isRecording]);

  const startRecording = useCallback(async () => {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (err) {
      console.error("Failed to start recording", err);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    setIsRecording(false);
    setIsProcessing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (!uri) throw new Error("No recording URI");

      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

      // 1. Transcribe
      const formData = new FormData();
      formData.append("file", {
        uri,
        type: "audio/m4a",
        name: "recording.m4a",
      } as any);

      const transcribeRes = await fetch(`${API_BASE}/transcribe`, {
        method: "POST",
        body: formData,
      });
      const { text } = await transcribeRes.json();
      if (!text) throw new Error("Empty transcription");
      setTranscript(text);

      // 2. Chat
      const chatRes = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const chatData = await chatRes.json();
      const reply = chatData.response || chatData.message || chatData.text || "";

      // 3. TTS
      const ttsRes = await fetch(`${API_BASE}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });
      const audioBlob = await ttsRes.blob();
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = (reader.result as string).split(",")[1];
        const { sound } = await Audio.Sound.createAsync(
          { uri: `data:audio/mp3;base64,${base64}` },
          { shouldPlay: true }
        );
        soundRef.current = sound;
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync();
          }
        });
      };
      reader.readAsDataURL(audioBlob);
    } catch (err) {
      console.error("Processing error:", err);
      setTranscript("Something went wrong. Try again.");
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const glowColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(78, 205, 196, 0)", "rgba(78, 205, 196, 0.3)"],
  });

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safe}>
        {/* Canvas area */}
        <View style={styles.canvasContainer}>
          <WebView
            source={{ html: canvasHtml }}
            style={styles.webview}
            scrollEnabled={true}
            javaScriptEnabled={true}
            originWhitelist={["*"]}
          />
        </View>

        {/* Transcript */}
        {transcript ? (
          <View style={styles.transcriptBar}>
            <Text style={styles.transcriptText} numberOfLines={2}>
              {transcript}
            </Text>
          </View>
        ) : null}

        {/* Mic button area */}
        <View style={styles.micArea}>
          {isProcessing ? (
            <View style={styles.processingContainer}>
              <ActivityIndicator size="large" color="#4ecdc4" />
              <Text style={styles.processingText}>Thinking...</Text>
            </View>
          ) : (
            <Animated.View
              style={[
                styles.micGlow,
                { backgroundColor: glowColor, transform: [{ scale: pulseAnim }] },
              ]}
            >
              <TouchableOpacity
                style={[styles.micButton, isRecording && styles.micButtonActive]}
                onPressIn={startRecording}
                onPressOut={stopRecording}
                activeOpacity={0.8}
              >
                <View style={styles.micIcon}>
                  {isRecording ? (
                    <View style={styles.micWaves}>
                      <View style={[styles.wave, styles.wave1]} />
                      <View style={[styles.wave, styles.wave2]} />
                      <View style={[styles.wave, styles.wave3]} />
                    </View>
                  ) : (
                    <Text style={styles.micEmoji}>🎙</Text>
                  )}
                </View>
              </TouchableOpacity>
            </Animated.View>
          )}
          <Text style={styles.hint}>
            {isRecording ? "Listening..." : isProcessing ? "" : "Hold to speak"}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  safe: { flex: 1 },
  canvasContainer: {
    flex: 1,
    margin: 16,
    marginBottom: 8,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#0a0a0a",
    borderWidth: 1,
    borderColor: "#1a1a1a",
  },
  webview: { flex: 1, backgroundColor: "#0a0a0a" },
  transcriptBar: {
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  transcriptText: {
    color: "#666",
    fontSize: 13,
    textAlign: "center",
    fontStyle: "italic",
  },
  micArea: {
    alignItems: "center",
    paddingBottom: Platform.OS === "ios" ? 20 : 32,
    paddingTop: 8,
  },
  micGlow: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  micButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#1a1a1a",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#2a2a2a",
  },
  micButtonActive: {
    backgroundColor: "#0d2b29",
    borderColor: "#4ecdc4",
  },
  micIcon: { alignItems: "center", justifyContent: "center" },
  micEmoji: { fontSize: 28 },
  micWaves: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  wave: {
    width: 3,
    backgroundColor: "#4ecdc4",
    borderRadius: 2,
  },
  wave1: { height: 12 },
  wave2: { height: 24 },
  wave3: { height: 16 },
  hint: {
    color: "#555",
    fontSize: 12,
    marginTop: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  processingContainer: { alignItems: "center" },
  processingText: { color: "#4ecdc4", fontSize: 13, marginTop: 8 },
});
