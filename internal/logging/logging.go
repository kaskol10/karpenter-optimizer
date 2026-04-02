package logging

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type Level string

const (
	LevelDebug Level = "debug"
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

type Logger struct {
	mu        sync.Mutex
	output    io.Writer
	level     Level
	timestamp bool
	requestID string
}

type LogEntry struct {
	Timestamp string                 `json:"timestamp"`
	Level     Level                  `json:"level"`
	Message   string                 `json:"message"`
	RequestID string                 `json:"requestId,omitempty"`
	Fields    map[string]interface{} `json:"fields,omitempty"`
}

var defaultLogger *Logger

func init() {
	defaultLogger = &Logger{
		output:    os.Stdout,
		level:     LevelInfo,
		timestamp: true,
	}
}

func Default() *Logger {
	return defaultLogger
}

func New(output io.Writer, level Level) *Logger {
	return &Logger{
		output:    output,
		level:     level,
		timestamp: true,
	}
}

func (l *Logger) SetLevel(level Level) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.level = level
}

func (l *Logger) SetRequestID(reqID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requestID = reqID
}

func (l *Logger) Debug(msg string, fields ...map[string]interface{}) {
	l.log(LevelDebug, msg, fields...)
}

func (l *Logger) Info(msg string, fields ...map[string]interface{}) {
	l.log(LevelInfo, msg, fields...)
}

func (l *Logger) Warn(msg string, fields ...map[string]interface{}) {
	l.log(LevelWarn, msg, fields...)
}

func (l *Logger) Error(msg string, fields ...map[string]interface{}) {
	l.log(LevelError, msg, fields...)
}

func (l *Logger) log(level Level, msg string, fields ...map[string]interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if !l.shouldLog(level) {
		return
	}

	entry := LogEntry{
		Message:   msg,
		Level:     level,
		RequestID: l.requestID,
	}

	if l.timestamp {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	if len(fields) > 0 {
		entry.Fields = fields[0]
	}

	data, err := json.Marshal(entry)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to marshal log: %v\n", err)
		return
	}

	fmt.Fprintln(l.output, string(data))
}

func (l *Logger) shouldLog(level Level) bool {
	levels := map[Level]int{
		LevelDebug: 0,
		LevelInfo:  1,
		LevelWarn:  2,
		LevelError: 3,
	}

	currentLevel, ok := levels[l.level]
	if !ok {
		currentLevel = 1
	}

	msgLevel, ok := levels[level]
	if !ok {
		msgLevel = 1
	}

	return msgLevel >= currentLevel
}

func Debug(msg string, fields ...map[string]interface{}) {
	defaultLogger.log(LevelDebug, msg, fields...)
}

func Info(msg string, fields ...map[string]interface{}) {
	defaultLogger.log(LevelInfo, msg, fields...)
}

func Warn(msg string, fields ...map[string]interface{}) {
	defaultLogger.log(LevelWarn, msg, fields...)
}

func Error(msg string, fields ...map[string]interface{}) {
	defaultLogger.log(LevelError, msg, fields...)
}

func SetLevel(level Level) {
	defaultLogger.SetLevel(level)
}

func SetRequestID(reqID string) {
	defaultLogger.SetRequestID(reqID)
}
