provider "aws" {
  default_tags {
    tags = {
      Project = "presta"
      Source  = "https://github.com/lasuillard-s/presta.git"
    }
  }
}
