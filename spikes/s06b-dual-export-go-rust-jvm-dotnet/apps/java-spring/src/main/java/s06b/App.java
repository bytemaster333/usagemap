package s06b;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** S-06b Java sample API (Spring Boot, Spring MVC). No OpenTelemetry code: the Java agent instruments it. */
@SpringBootApplication
@RestController
public class App {
  public static void main(String[] args) {
    SpringApplication.run(App.class, args);
  }

  @GetMapping("/health")
  Map<String, String> health() {
    return Map.of("status", "ok");
  }

  @GetMapping("/accounts/{id}")
  ResponseEntity<Map<String, String>> account(@PathVariable String id) {
    if (id.equals("GNOTFOUND")) {
      return ResponseEntity.status(404).body(Map.of("error", "account not found"));
    }
    return ResponseEntity.ok(Map.of("id", id, "balance", "100.0000000"));
  }

  @GetMapping("/assets/{code}/{issuer}")
  Map<String, String> asset(@PathVariable String code, @PathVariable String issuer) throws InterruptedException {
    Thread.sleep(15);
    return Map.of("code", code, "issuer", issuer);
  }

  @PostMapping("/payments")
  ResponseEntity<Map<String, String>> payments() {
    return ResponseEntity.badRequest().body(Map.of("error", "invalid payment"));
  }

  @GetMapping("/boom")
  ResponseEntity<Map<String, String>> boom() {
    return ResponseEntity.status(500).body(Map.of("error", "internal"));
  }
}
