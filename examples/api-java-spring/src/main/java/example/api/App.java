// SPDX-License-Identifier: Apache-2.0
package example.api;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** The tenant's API: one route. No OpenTelemetry code; the Java agent instruments it. */
@SpringBootApplication
@RestController
public class App {
  public static void main(String[] args) {
    SpringApplication.run(App.class, args);
  }

  @GetMapping("/accounts/{id}")
  ResponseEntity<Map<String, String>> account(@PathVariable String id) {
    return switch (id) {
      case "GMISSING" -> ResponseEntity.status(404).body(Map.of("error", "account not found"));
      case "GBOOM" -> ResponseEntity.status(500).body(Map.of("error", "internal"));
      default -> ResponseEntity.ok(Map.of("id", id));
    };
  }
}
