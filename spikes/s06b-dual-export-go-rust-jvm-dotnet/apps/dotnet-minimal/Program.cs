// S-06b .NET sample API: ASP.NET Core minimal API + OpenTelemetry .NET 1.21.0, dual export.
using OpenTelemetry.Exporter;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);
string Env(string k) => Environment.GetEnvironmentVariable(k) ?? "";
var apm = Env("APM_ENDPOINT");
var scf = Env("SCF_OTLP_ENDPOINT");

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService(Env("OTEL_SERVICE_NAME")))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddOtlpExporter("apm-traces", o =>
        {
            o.Endpoint = new Uri($"{apm}/v1/traces");
            o.Protocol = OtlpExportProtocol.HttpProtobuf;
            o.Headers = $"api-key={Env("APM_API_KEY")}";
        }))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddOtlpExporter("apm-metrics", o =>
        {
            o.Endpoint = new Uri($"{apm}/v1/metrics");
            o.Protocol = OtlpExportProtocol.HttpProtobuf;
            o.Headers = $"api-key={Env("APM_API_KEY")}";
        })
        .AddOtlpExporter("scf", o =>
        {
            o.Endpoint = new Uri($"{scf}/v1/metrics");
            o.Protocol = OtlpExportProtocol.HttpProtobuf;
            o.Headers = $"Authorization=Bearer {Env("SCF_OTLP_TOKEN")}";
        }));

var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/accounts/{id}", (string id) => id == "GNOTFOUND"
    ? Results.NotFound(new { error = "account not found" })
    : Results.Ok(new { id, balance = "100.0000000" }));
app.MapGet("/assets/{code}/{issuer}", async (string code, string issuer) =>
{
    await Task.Delay(15);
    return Results.Ok(new { code, issuer });
});
app.MapPost("/payments", () => Results.BadRequest(new { error = "invalid payment" }));
app.MapGet("/boom", () => Results.Json(new { error = "internal" }, statusCode: 500));
app.Run("http://0.0.0.0:8080");
