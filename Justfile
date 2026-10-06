_default:
    just --list

# Install deps and tools
install:
    npm install

# Update deps and tools
update:
    npm update
    pre-commit autoupdate

alias up := update

# =============================================================================
# Development
# =============================================================================

# Run all checks
ci: (format "yes") lint test

# Autoformat code
[arg("check", long="check", value="yes")]
format check="no":
    npm run {{ if check == "yes" { "fmt:check" } else { "fmt" } }}

alias fmt := format

# Run all linters
lint:
    npm run lint
    npm run typecheck

# Run all tests
test:
    npm run test

# Apply autofixes
fix:
    npm run lint:fix
    npm run fmt

# Build the application
build:
    npm run build

# Run local development server
run:
    npm run dev:watch

# =============================================================================
# Utility
# =============================================================================

# Remove temporary files
clean:
    rm --recursive --force \
        .vitest/ \
        coverage/ \
        dist/ \
        junit.xml
    find . -path '*.log*' -delete
