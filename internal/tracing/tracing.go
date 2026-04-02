package tracing

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
	"go.opentelemetry.io/otel/trace"
)

var tracer *sdktrace.TracerProvider

func Init(serviceName string, enabled bool) (*sdktrace.TracerProvider, error) {
	if !enabled {
		return nil, nil
	}

	exporter, err := stdouttrace.New(
		stdouttrace.WithPrettyPrint(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create trace exporter: %w", err)
	}

	res, err := resource.New(context.Background(),
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	tracer = tp

	return tp, nil
}

func Shutdown(ctx context.Context) error {
	if tracer != nil {
		return tracer.Shutdown(ctx)
	}
	return nil
}

func StartSpan(ctx context.Context, name string) (context.Context, func()) {
	if tracer == nil {
		return ctx, func() {}
	}

	tracer := otel.Tracer("karpenter-optimizer")
	ctx, span := tracer.Start(ctx, name)
	return ctx, func() {
		span.End()
	}
}

func AddSpanAttributes(ctx context.Context, attrs ...attribute.KeyValue) {
	span := trace.SpanFromContext(ctx)
	if span != nil {
		span.SetAttributes(attrs...)
	}
}

func RecordError(ctx context.Context, err error) {
	span := trace.SpanFromContext(ctx)
	if span != nil {
		span.RecordError(err)
	}
}

type SpanTimer struct {
	ctx   context.Context
	name  string
	start time.Time
}

func StartTimer(ctx context.Context, name string) *SpanTimer {
	return &SpanTimer{
		ctx:   ctx,
		name:  name,
		start: time.Now(),
	}
}

func (t *SpanTimer) End() {
	elapsed := time.Since(t.start)
	span := trace.SpanFromContext(t.ctx)
	if span != nil {
		span.SetAttributes(attribute.Float64(t.name, elapsed.Seconds()))
	}
}
