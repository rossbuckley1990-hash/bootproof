console.error("config/database.yml is missing (RuntimeError)");
for (let index = 0; index < 300; index++) {
  console.error(`/app/vendor/bundle/ruby/3.3.0/gems/rails/lib/rails-${index}.rb:${index + 1}:in 'boot'`);
}
process.exit(1);
